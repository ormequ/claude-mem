import { describe, expect, it } from 'bun:test';
import { createServerBetaGenerationWorkerKeepAlive } from '../../src/server/runtime/ServerBetaService.js';

describe('server-beta generation worker keepalive', () => {
  it('creates a referenced timer so Bun keeps the worker process alive', () => {
    const timer = createServerBetaGenerationWorkerKeepAlive();
    try {
      if (typeof timer.hasRef === 'function') {
        expect(timer.hasRef()).toBe(true);
      }
    } finally {
      clearInterval(timer);
    }
  });
});
