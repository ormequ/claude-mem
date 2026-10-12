/**
 * Fork-owned: a process-wide minimum interval between outbound provider calls.
 *
 * The rate ceilings that matter here are per-account, not per-session, so the
 * budget has to be shared: the storms that trip them happen when several
 * generators (one per session) fire at once, each of them well under any
 * per-session limit. GeminiProvider's `enforceRateLimitForModel` is the same
 * idea, but it re-reads one module-level timestamp after the wait — two
 * concurrent callers read the same value, wait the same amount and then fire
 * together. Here the slot is reserved synchronously before the first `await`,
 * so concurrent callers queue behind each other instead of colliding.
 */

import { logger } from '../../utils/logger.js';
import { isClassified } from './provider-errors.js';
import { MAX_RETRY_AFTER_MS, type RetryOptions } from './retry.js';

export interface PacerClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: PacerClock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
};

export class CallPacer {
  private nextSlotAt = 0;

  constructor(private readonly clock: PacerClock = realClock) {}

  /** Wait until this caller's slot. Returns immediately when pacing is off. */
  async acquire(minIntervalMs: number): Promise<void> {
    if (!(minIntervalMs > 0)) return;

    const now = this.clock.now();
    const slotAt = Math.max(now, this.nextSlotAt);
    // Reserve first, await second — the reservation must not be interleaved.
    this.nextSlotAt = slotAt + minIntervalMs;

    const waitMs = slotAt - now;
    if (waitMs > 0) {
      logger.debug('SDK', `Pacing: waiting ${waitMs}ms for the next call slot`, { minIntervalMs });
      await this.clock.sleep(waitMs);
    }
  }

  /**
   * Hold every caller off for `ms`. Used when the provider has already refused
   * a request: the ceiling is account-wide, so the sibling generators that did
   * not get the 429 must stop hammering it too.
   */
  defer(ms: number): void {
    if (!(ms > 0)) return;
    this.nextSlotAt = Math.max(this.nextSlotAt, this.clock.now() + ms);
    logger.warn('SDK', `Provider refused a request; holding all sessions off for ${ms}ms`);
  }

  /** Next free slot as an epoch ms timestamp — for tests and diagnostics. */
  get nextSlot(): number {
    return this.nextSlotAt;
  }
}

/** Shared by every session's generator, one per provider. */
export const openRouterPacer = new CallPacer();
export const openAICompatPacer = new CallPacer();

/** One provider's pacing + retry policy, from its `<prefix>_*` settings keys. */
export interface PacingPolicy {
  rateLimitingEnabled: boolean;
  minRequestIntervalMs: number;
  /** The wall-clock window a tripped ceiling needs; withRetry's `rateLimitDelayMs`. */
  rateLimitBackoffMs: number;
  maxRetries: number;
}

/**
 * Same posture as the Gemini rate-limiting switch: on unless explicitly
 * disabled, since a gateway refusing this path costs a whole batch.
 * Non-numeric spellings fall back to the defaults.
 */
export function resolvePacingPolicy(
  settings: object,
  prefix: 'CLAUDE_MEM_OPENROUTER' | 'CLAUDE_MEM_OPENAI_COMPAT',
): PacingPolicy {
  const read = (suffix: string): unknown => (settings as Record<string, unknown>)[`${prefix}_${suffix}`];
  return {
    rateLimitingEnabled: String(read('RATE_LIMITING_ENABLED')) !== 'false',
    minRequestIntervalMs: Number(read('MIN_REQUEST_INTERVAL_MS')) || 1500,
    rateLimitBackoffMs: Number(read('RATE_LIMIT_BACKOFF_MS')) || 75_000,
    maxRetries: Number(read('MAX_RETRIES')) || 4,
  };
}

/**
 * The withRetry options for a policy. Rate limiting off means upstream's retry
 * policy, untouched: no pacing, no window, no retry-count override.
 */
export function pacedRetryOptions(policy: PacingPolicy): Pick<RetryOptions, 'maxRetries' | 'rateLimitDelayMs'> {
  return policy.rateLimitingEnabled
    ? { maxRetries: policy.maxRetries, rateLimitDelayMs: policy.rateLimitBackoffMs }
    : {};
}

/**
 * Wait for this worker's next call slot, then run the attempt. A refusal
 * holds every session off, not just the generator that got the 429 — the
 * ceiling is per-account, and the storms that trip it are several sessions
 * generating at once.
 *
 * Except when the key pool has another key to rotate to (`poolSize` > 1):
 * then the pool's per-key cooldown owns the window, and holding everyone off
 * would stall the very rotation that sidesteps it. The deferral is capped the
 * way withRetry caps its own wait, so a Retry-After of an hour cannot park the
 * pacer longer than the retry it precedes.
 */
export async function pacedAttempt<T>(
  pacer: CallPacer,
  policy: PacingPolicy,
  poolSize: number,
  attempt: () => Promise<T>,
): Promise<T> {
  if (!policy.rateLimitingEnabled) return attempt();

  await pacer.acquire(policy.minRequestIntervalMs);
  try {
    return await attempt();
  } catch (err: unknown) {
    if (poolSize <= 1 && isClassified(err) && err.kind === 'rate_limit') {
      const capMs = Math.max(MAX_RETRY_AFTER_MS, policy.rateLimitBackoffMs);
      pacer.defer(Math.min(err.retryAfterMs ?? policy.rateLimitBackoffMs, capMs));
    }
    throw err;
  }
}
