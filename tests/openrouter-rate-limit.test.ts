import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { withRetry } from '../src/services/worker/retry';
import { ClassifiedProviderError } from '../src/services/worker/provider-errors';
import { CallPacer, type PacerClock } from '../src/services/worker/call-pacer';
import { OpenAICompatProvider } from '../src/services/worker/OpenAICompatProvider';

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

/**
 * Discrete-event clock for several concurrent callers: simulated time only
 * advances, to the earliest pending sleep, once nothing else can progress.
 */
function eventClock() {
  let now = 0;
  const timers: Array<{ at: number; resolve: () => void }> = [];
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  };
  return {
    now: () => now,
    sleep: (ms: number) => new Promise<void>(resolve => { timers.push({ at: now + ms, resolve }); }),
    async run<T>(work: Promise<T>): Promise<T> {
      let settled = false;
      work.then(() => { settled = true; }, () => { settled = true; });
      while (!settled) {
        await settle();
        if (settled || timers.length === 0) continue;
        timers.sort((a, b) => a.at - b.at);
        const next = timers.shift()!;
        now = Math.max(now, next.at);
        next.resolve();
      }
      return work;
    },
  };
}

describe('openai-compatible provider against a rolling rate ceiling', () => {
  const ENV = {
    CLAUDE_MEM_OPENAI_COMPAT_BASE_URL: 'https://gateway.example.test/v4',
    CLAUDE_MEM_OPENAI_COMPAT_MODEL: 'glm-test',
    CLAUDE_MEM_OPENAI_COMPAT_API_KEY: 'compat-key',
    // On by default; pinned so a test preload that turns it off for the
    // upstream suite cannot turn this guard into a no-op.
    CLAUDE_MEM_OPENAI_COMPAT_RATE_LIMITING_ENABLED: 'true',
  };
  const realFetch = globalThis.fetch;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const [key, value] of Object.entries(ENV)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /** One generator per session; every session shares the worker's pacer. */
  function sessions(count: number, clock: ReturnType<typeof eventClock>) {
    const pacer = new CallPacer({ now: clock.now, sleep: clock.sleep });
    return Array.from({ length: count }, () => {
      const provider = new OpenAICompatProvider(null as never, null as never) as any;
      provider.pacer = pacer;
      provider.retrySleepFn = clock.sleep;
      return provider;
    });
  }

  /** The gateway: 429 with no Retry-After until the window clears. */
  function gateway(clock: ReturnType<typeof eventClock>, sends: number[]) {
    globalThis.fetch = (async () => {
      sends.push(clock.now());
      return clock.now() < OUTAGE_MS
        ? new Response('Too Many Requests', { status: 429 })
        : Response.json({ choices: [{ message: { content: 'observation batch' } }] });
    }) as unknown as typeof fetch;
  }

  const history = [{ role: 'user', content: 'tool use' }];

  it('outlives a ~75s outage with default settings', async () => {
    const clock = eventClock();
    const sends: number[] = [];
    gateway(clock, sends);
    const [provider] = sessions(1, clock);

    const result = await clock.run(provider.query(history, provider.getConfig()));

    expect(result.content).toBe('observation batch');
    expect(sends).toHaveLength(2);
    expect(sends[1]).toBeGreaterThanOrEqual(OUTAGE_MS);
  });

  it('makes concurrent sessions share one budget and wait the window out together', async () => {
    const clock = eventClock();
    const sends: number[] = [];
    gateway(clock, sends);
    const providers = sessions(3, clock);

    const results = await clock.run(Promise.all(
      providers.map(provider => provider.query(history, provider.getConfig())),
    ));

    expect(results.map((result: { content: string }) => result.content)).toEqual(Array(3).fill('observation batch'));
    // Each session is refused at most once: nobody retries into the closed window.
    expect(sends).toHaveLength(6);
    expect(sends.filter(at => at >= OUTAGE_MS)).toHaveLength(3);
    // One shared budget: no two sends closer than the minimum interval.
    const sorted = [...sends].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(1_500);
    }
  });
});
