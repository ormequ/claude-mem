import { describe, it, expect } from 'bun:test';
import { withRetry } from '../src/services/worker/retry';
import { ClassifiedProviderError } from '../src/services/worker/provider-errors';
import { CallPacer, type PacerClock } from '../src/services/worker/call-pacer';

/**
 * The endpoint behind the OpenAI-compatible path answers 429 under sustained
 * load and clears the ceiling on a wall-clock window of ~75s — not on an
 * exponential curve. These tests drive a simulated clock: no test sleeps.
 */

const RATE_LIMIT_DELAY_MS = 75_000;
/** Measured recovery window of a tripped ceiling. */
const OUTAGE_MS = 74_000;

function rateLimited(retryAfterMs?: number): ClassifiedProviderError {
  return new ClassifiedProviderError('rate limit (429)', {
    kind: 'rate_limit',
    cause: new Error('429'),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
}

/** Simulated clock: sleeping advances time instead of waiting for it. */
function simulatedClock() {
  const slept: number[] = [];
  const state = {
    now: 0,
    slept,
    sleep: async (ms: number) => {
      slept.push(ms);
      state.now += ms;
    },
  };
  return state;
}

describe('withRetry against a rolling rate ceiling', () => {
  it('outlives a ~75s outage and returns the eventual success', async () => {
    const clock = simulatedClock();
    let attempts = 0;

    const result = await withRetry(async () => {
      attempts++;
      if (clock.now < OUTAGE_MS) throw rateLimited();
      return 'observation batch';
    }, {
      maxRetries: 4,
      rateLimitDelayMs: RATE_LIMIT_DELAY_MS,
      sleepFn: clock.sleep,
    });

    expect(result).toBe('observation batch');
    expect(attempts).toBe(2);
    expect(clock.now).toBeGreaterThanOrEqual(OUTAGE_MS);
  });

  it('would have given up under the pre-fix policy (regression anchor)', async () => {
    const clock = simulatedClock();

    const attempt = withRetry(async () => {
      if (clock.now < OUTAGE_MS) throw rateLimited();
      return 'observation batch';
    }, {
      // Defaults before the fix: 2 retries, 100ms base, 30s cap, no window.
      maxRetries: 2,
      baseDelayMs: 100,
      maxDelayMs: 30_000,
      sleepFn: clock.sleep,
    });

    await expect(attempt).rejects.toThrow('rate limit (429)');
    expect(clock.now).toBeLessThan(OUTAGE_MS);
  });

  it('honors Retry-After over the configured window', async () => {
    const clock = simulatedClock();
    let attempts = 0;

    await withRetry(async () => {
      if (attempts++ === 0) throw rateLimited(5_000);
      return 'ok';
    }, { maxRetries: 4, rateLimitDelayMs: RATE_LIMIT_DELAY_MS, sleepFn: clock.sleep });

    // 5s + up to 2s of anti-lockstep jitter.
    expect(clock.slept).toHaveLength(1);
    expect(clock.slept[0]).toBeGreaterThanOrEqual(5_000);
    expect(clock.slept[0]).toBeLessThan(7_000);
  });

  it('clamps an absurd Retry-After to the configured window', async () => {
    const clock = simulatedClock();
    let attempts = 0;

    await withRetry(async () => {
      if (attempts++ === 0) throw rateLimited(3_600_000);
      return 'ok';
    }, { maxRetries: 4, rateLimitDelayMs: RATE_LIMIT_DELAY_MS, sleepFn: clock.sleep });

    expect(clock.slept[0]).toBeLessThanOrEqual(RATE_LIMIT_DELAY_MS);
  });

  it.each(['auth_invalid', 'unrecoverable', 'quota_exhausted'])(
    'gives up immediately on %s — waiting cannot help',
    async (kind) => {
      const clock = simulatedClock();
      let attempts = 0;

      const run = withRetry(async () => {
        attempts++;
        throw new ClassifiedProviderError(`fatal ${kind}`, { kind, cause: new Error(kind) });
      }, { maxRetries: 4, rateLimitDelayMs: RATE_LIMIT_DELAY_MS, sleepFn: clock.sleep });

      await expect(run).rejects.toThrow(`fatal ${kind}`);
      expect(attempts).toBe(1);
      expect(clock.slept).toHaveLength(0);
    },
  );
});

describe('CallPacer', () => {
  function pacerWithClock(): { pacer: CallPacer; clock: ReturnType<typeof simulatedClock> } {
    const clock = simulatedClock();
    const pacerClock: PacerClock = { now: () => clock.now, sleep: clock.sleep };
    return { pacer: new CallPacer(pacerClock), clock };
  }

  it('spaces sequential calls by the minimum interval', async () => {
    const { pacer, clock } = pacerWithClock();

    await pacer.acquire(1_500);   // first call goes straight through
    await pacer.acquire(1_500);
    await pacer.acquire(1_500);

    expect(clock.slept).toEqual([1_500, 1_500]);
    expect(clock.now).toBe(3_000);
  });

  it('shares one budget across concurrent callers', async () => {
    // Time frozen at 0: every caller arrives at the same instant, so the wait
    // each one is handed is its offset in the shared queue.
    const slept: number[] = [];
    const pacer = new CallPacer({ now: () => 0, sleep: async (ms: number) => { slept.push(ms); } });

    // Four sessions generating at once — the storm shape that trips the ceiling.
    await Promise.all([
      pacer.acquire(1_500),
      pacer.acquire(1_500),
      pacer.acquire(1_500),
      pacer.acquire(1_500),
    ]);

    expect(slept).toEqual([1_500, 3_000, 4_500]);
  });

  it('holds every caller off after a refusal', async () => {
    const { pacer, clock } = pacerWithClock();

    pacer.defer(75_000);
    await pacer.acquire(1_500);

    expect(clock.slept).toEqual([75_000]);
  });

  it('is a no-op when pacing is disabled', async () => {
    const { pacer, clock } = pacerWithClock();

    await pacer.acquire(0);
    await pacer.acquire(0);

    expect(clock.slept).toHaveLength(0);
  });
});
