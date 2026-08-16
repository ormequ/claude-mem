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

/** Shared by every session's generator on the OpenAI-compatible path. */
export const openRouterPacer = new CallPacer();
