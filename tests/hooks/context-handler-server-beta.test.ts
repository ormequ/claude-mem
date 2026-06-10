// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

import * as realHookSettings from '../../src/shared/hook-settings.js';
import * as realLogger from '../../src/utils/logger.js';
import * as realWorkerUtils from '../../src/shared/worker-utils.js';

const realHookSettingsSnapshot = { ...realHookSettings };
const realLoggerSnapshot = { ...realLogger };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };

let mockSettings: Record<string, string> = {};
let workerCalls = 0;
let recentContextResponse = '# [MKS] recent context\n\nJune 10 server-beta observation';

mock.module('../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({ ...mockSettings }),
}));

mock.module('../../src/utils/logger.js', () => ({
  logger: {
    warn: () => {},
    info: () => {},
    debug: () => {},
    error: () => {},
    failure: () => {},
    dataIn: () => {},
    formatTool: () => '',
  },
}));

mock.module('../../src/shared/worker-utils.js', () => ({
  ...realWorkerUtilsSnapshot,
  executeWithWorkerFallback: async () => {
    workerCalls += 1;
    return '# [MKS] recent context\n\nJune 8 worker observation';
  },
  isWorkerFallback: realWorkerUtilsSnapshot.isWorkerFallback,
  getWorkerPort: () => 37701,
}));

mock.module('../../src/services/hooks/runtime-selector.js', () => ({
  resolveRuntimeContext: () => ({
    runtime: 'server-beta',
    projectId: mockSettings.CLAUDE_MEM_SERVER_BETA_PROJECT_ID,
    serverBaseUrl: mockSettings.CLAUDE_MEM_SERVER_BETA_URL,
    client: {
      async recentContext(input: { projectId: string; projectName?: string; limit?: number }) {
      expect(input.projectId).toBe('project-uuid');
      expect(input.projectName).toBe('MKS');
      expect(input.limit).toBe(50);
      return { observations: [], context: recentContextResponse };
      },
    },
  }),
  logServerBetaFallback: () => {},
}));

afterAll(() => {
  mock.module('../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../src/utils/logger.js', () => realLoggerSnapshot);
  mock.module('../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
});

describe('contextHandler server-beta runtime', () => {
  beforeEach(() => {
    workerCalls = 0;
    recentContextResponse = '# [MKS] recent context\n\nJune 10 server-beta observation';
    mockSettings = {
      CLAUDE_MEM_RUNTIME: 'server-beta',
      CLAUDE_MEM_SERVER_BETA_URL: 'http://127.0.0.1:37877',
      CLAUDE_MEM_SERVER_BETA_API_KEY: 'cmem_test',
      CLAUDE_MEM_SERVER_BETA_PROJECT_ID: 'project-uuid',
    };
  });

  it('uses server-beta recent context instead of the worker context endpoint', async () => {
    const { contextHandler } = await import('../../src/cli/handlers/context.js');
    const result = await contextHandler.execute({
      cwd: '/Users/belokobylskiiilia/Development/MKS',
      platform: 'claude-code',
    });

    expect(workerCalls).toBe(0);
    expect(result.hookSpecificOutput?.hookEventName).toBe('SessionStart');
    expect(result.hookSpecificOutput?.additionalContext).toContain('June 10 server-beta observation');
    expect(result.hookSpecificOutput?.additionalContext).not.toContain('June 8 worker observation');
  });

  it('does not fetch worker colored timeline for server-beta terminal output', async () => {
    mockSettings.CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT = 'true';
    const { contextHandler } = await import('../../src/cli/handlers/context.js');
    const result = await contextHandler.execute({
      cwd: '/Users/belokobylskiiilia/Development/MKS',
      platform: 'claude-code',
    });

    expect(workerCalls).toBe(0);
    expect(result.systemMessage).toContain('June 10 server-beta observation');
    expect(result.systemMessage).toContain('http://127.0.0.1:37877');
    expect(result.systemMessage).not.toContain('June 8 worker observation');
    expect(result.systemMessage).not.toContain('localhost:37701');
  });
});
