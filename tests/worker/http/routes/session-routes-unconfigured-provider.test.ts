import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { logger } from '../../../../src/utils/logger.js';
import { SessionRoutes } from '../../../../src/services/worker/http/routes/SessionRoutes.js';
import type { ActiveSession } from '../../../../src/services/worker-types.js';

/**
 * FORK (owner decision 5): when CLAUDE_MEM_PROVIDER names an HTTP provider that
 * is not configured, upstream's dispatch falls through to Claude and bills the
 * subscription. The fork idles instead: no generator starts, the work stays
 * buffered, and the warning is rate-limited. Real dispatch, settings pinned
 * through env (applied last by SettingsDefaultsManager).
 */

const ENV = {
  CLAUDE_MEM_PROVIDER: 'openai-compatible',
  CLAUDE_MEM_OPENAI_COMPAT_PRESET: '',
  CLAUDE_MEM_OPENAI_COMPAT_BASE_URL: '',
  CLAUDE_MEM_OPENAI_COMPAT_MODEL: '',
  CLAUDE_MEM_OPENAI_COMPAT_API_KEY: '',
  CLAUDE_MEM_OPENAI_COMPAT_API_KEYS: '',
  CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: '',
};

function makeSession(): ActiveSession {
  return {
    sessionDbId: 5005,
    contentSessionId: 'content-5005',
    memorySessionId: null,
    project: 'test-project',
    platformSource: 'claude-code',
    userPrompt: 'prompt',
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [],
    conversationHistory: [],
    currentProvider: null,
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    consecutiveContextOverflows: 0,
    lastGeneratorActivity: Date.now(),
  };
}

describe('SessionRoutes with a selected but unconfigured provider', () => {
  let saved: Record<string, string | undefined>;
  let warn: ReturnType<typeof spyOn>;
  let otherSpies: ReturnType<typeof spyOn>[];

  beforeEach(() => {
    saved = {};
    for (const [key, value] of Object.entries(ENV)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    warn = spyOn(logger, 'warn').mockImplementation(() => {});
    otherSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    warn.mockRestore();
    otherSpies.forEach(spy => spy.mockRestore());
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('never starts the Claude generator, keeps the work buffered, and warns once', async () => {
    const session = makeSession();
    const claudeStart = mock(async () => {});
    const compatStart = mock(async () => {});
    const sessionManager = {
      getSession: mock((id: number) => (id === session.sessionDbId ? session : undefined)),
      getMessageBuffer: mock(() => ({ getPendingCount: () => 1, peekTypes: () => [] })),
      removeSessionImmediate: mock(() => {}),
    };
    const routes = new SessionRoutes(
      sessionManager as any,
      {} as any,
      { startSession: claudeStart } as any,
      { startSession: mock(async () => {}) } as any,
      { startSession: mock(async () => {}) } as any,
      {} as any,
      {} as any,
      { finalizeSession: mock(() => Promise.resolve()) } as any,
      undefined,
      { startSession: compatStart } as any,
    );

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await routes.ensureGeneratorRunning(session.sessionDbId, 'periodic-resume');

    expect(claudeStart).not.toHaveBeenCalled();
    expect(compatStart).not.toHaveBeenCalled();
    expect(session.generatorPromise).toBeNull();
    expect(sessionManager.removeSessionImmediate).not.toHaveBeenCalled();
    const idleWarnings = warn.mock.calls.filter(call => String(call[1]).startsWith('Memory capture idle'));
    expect(idleWarnings).toHaveLength(1);
    expect(String(idleWarnings[0][1])).toContain('CLAUDE_MEM_OPENAI_COMPAT_BASE_URL');
  });
});
