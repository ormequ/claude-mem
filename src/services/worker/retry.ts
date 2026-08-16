/**
 * Retry helper that consumes ClassifiedProviderError.kind to decide whether to
 * retry. Pattern adapted from open-agent-sdk's retry.ts (MIT) — exponential
 * backoff with jitter, but driven by classified error kinds, not raw HTTP
 * status codes.
 *
 * Used by GeminiProvider + OpenRouterProvider for fetch retries. Cap retries
 * at 2 because POSTs to these APIs aren't strictly idempotent; we honor a
 * provider-supplied request-id (best-effort) for dedup. The OpenRouter path
 * overrides the cap and the rate-limit wait from settings — a rolling request
 * ceiling outlives the default policy.
 */

import { ClassifiedProviderError, isClassified } from './provider-errors.js';
import { logger } from '../../utils/logger.js';

/**
 * Parse Retry-After header (seconds or HTTP-date).
 * Returns ms or undefined.
 */
export function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.floor(seconds * 1000);
  }
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

export interface RetryOptions {
  /** Maximum retry attempts (in addition to the initial attempt). Cap=2 by default for non-idempotent POSTs. */
  maxRetries?: number;
  /** Per-attempt timeout in ms. Default 30s. */
  perAttemptTimeoutMs?: number;
  /** Base delay used for exponential backoff. Default 100ms. */
  baseDelayMs?: number;
  /** Cap for backoff delay. Default 30s. */
  maxDelayMs?: number;
  /**
   * Wait applied to `rate_limit` errors that carry no Retry-After. A rolling
   * request ceiling clears on a wall-clock window, not on an exponential
   * curve — from a 100ms base the retries expire long before the window does.
   * Unset = old behavior (exponential backoff for rate limits too).
   */
  rateLimitDelayMs?: number;
  /** Tag for logging. */
  label?: string;
  /** External abort signal. */
  abortSignal?: AbortSignal;
  /** Sleep between attempts. Injectable so tests need not wait out real delays. */
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'label' | 'abortSignal' | 'rateLimitDelayMs' | 'sleepFn'>> = {
  maxRetries: 2,
  perAttemptTimeoutMs: 30_000,
  baseDelayMs: 100,
  maxDelayMs: 30_000,
};

/** Spread added to rate-limit waits so sibling callers don't retry in lockstep. */
const RATE_LIMIT_JITTER_MS = 2_000;

/** Default inter-attempt sleep: resolves early if the external signal aborts. */
function abortAwareSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Returns true if a classified error is worth retrying. */
export function isRetryableKind(err: unknown): boolean {
  if (!isClassified(err)) {
    // Unclassified errors are treated as transient (preserve old default).
    return true;
  }
  return err.kind === 'transient' || err.kind === 'rate_limit';
}

/** Compute backoff delay: 100 * 2^attempt + random(50). Capped at maxDelayMs. */
export function computeBackoffMs(attempt: number, opts: { baseDelayMs: number; maxDelayMs: number }): number {
  const exponential = opts.baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * 50;
  return Math.min(exponential + jitter, opts.maxDelayMs);
}

/**
 * Run `fn` with retry. `fn` receives an AbortSignal scoped to the current
 * attempt's timeout. The classified error from `fn` (if any) drives the
 * retry/no-retry decision. Honors `retryAfterMs` for rate_limit kind.
 */
export async function withRetry<T>(
  fn: (attemptSignal: AbortSignal) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    if (options.abortSignal?.aborted) {
      throw new Error('Aborted');
    }

    // Per-attempt timeout via AbortController. Forward external aborts too.
    const attemptController = new AbortController();
    const timeoutHandle = setTimeout(() => attemptController.abort(), opts.perAttemptTimeoutMs);
    const onExternalAbort = () => attemptController.abort();
    options.abortSignal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      return await fn(attemptController.signal);
    } catch (err: unknown) {
      lastError = err;

      if (!isRetryableKind(err)) {
        throw err;
      }

      if (attempt === opts.maxRetries) {
        throw err;
      }

      // Rate limits wait out a wall-clock window: Retry-After when the provider
      // sends one, else the configured window. Everything else backs off
      // exponentially. The cap admits the configured window (a caller must not
      // set a window its own maxDelayMs silently clamps away) and stays absent
      // for callers that configured none — there, Retry-After is honored
      // verbatim, as before.
      const rateLimitBase = isClassified(err) && err.kind === 'rate_limit'
        ? err.retryAfterMs ?? options.rateLimitDelayMs
        : undefined;
      const rateLimitCap = options.rateLimitDelayMs !== undefined
        ? Math.max(opts.maxDelayMs, options.rateLimitDelayMs)
        : Number.POSITIVE_INFINITY;
      const delayMs = rateLimitBase !== undefined
        ? Math.min(rateLimitBase + Math.random() * RATE_LIMIT_JITTER_MS, rateLimitCap)
        : computeBackoffMs(attempt, { baseDelayMs: opts.baseDelayMs, maxDelayMs: opts.maxDelayMs });

      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn('SDK', `Retrying ${opts.label ?? 'fetch'} after ${delayMs}ms (attempt ${attempt + 1}/${opts.maxRetries})`, {
        kind: isClassified(err) ? err.kind : 'unclassified',
        message: errMsg.substring(0, 200),
      });
      // Abort-aware sleep: an external abort during backoff should exit
      // immediately instead of waiting out the full delay.
      await (options.sleepFn ?? abortAwareSleep)(delayMs, options.abortSignal);
    } finally {
      clearTimeout(timeoutHandle);
      options.abortSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  // Reachable only if opts.maxRetries < 0 (loop never executed). The success
  // and exhaustion paths both return/throw inside the loop. This guards
  // pathological inputs and satisfies TypeScript's return-type exhaustiveness.
  throw lastError ?? new Error('withRetry exited without an attempt (maxRetries < 0)');
}
