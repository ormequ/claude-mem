import { describe, it, expect } from 'bun:test';
import { startPeriodicAdoption } from '../../../src/services/infrastructure/AdoptionScheduler.js';

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('startPeriodicAdoption', () => {
  it('invokes the adoption runner on each interval', async () => {
    let calls = 0;
    const timer = startPeriodicAdoption(10, async () => { calls++; return []; });
    await tick(35);
    clearInterval(timer);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('skips ticks while a previous run is still in flight', async () => {
    let calls = 0;
    const timer = startPeriodicAdoption(10, async () => {
      calls++;
      await tick(50); // longer than several intervals
      return [];
    });
    await tick(45);
    clearInterval(timer);
    expect(calls).toBe(1);
  });

  it('keeps ticking after a runner failure', async () => {
    let calls = 0;
    const timer = startPeriodicAdoption(10, async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return [];
    });
    await tick(35);
    clearInterval(timer);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('runs the drain after each adoption pass', async () => {
    let adoptions = 0;
    let drains = 0;
    const timer = startPeriodicAdoption(
      10,
      async () => { adoptions++; return []; },
      async () => { drains++; },
    );
    await tick(35);
    clearInterval(timer);
    expect(drains).toBeGreaterThanOrEqual(2);
    expect(drains).toBe(adoptions);
  });

  it('still runs the drain when the adoption pass fails', async () => {
    let drains = 0;
    const timer = startPeriodicAdoption(
      10,
      async () => { throw new Error('adopt boom'); },
      async () => { drains++; },
    );
    await tick(35);
    clearInterval(timer);
    expect(drains).toBeGreaterThanOrEqual(2);
  });

  it('keeps ticking after a drain failure', async () => {
    let drains = 0;
    const timer = startPeriodicAdoption(
      10,
      async () => [],
      async () => { drains++; throw new Error('drain boom'); },
    );
    await tick(35);
    clearInterval(timer);
    expect(drains).toBeGreaterThanOrEqual(2);
  });
});
