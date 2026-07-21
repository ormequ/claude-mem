import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';

// Keep the production worker helpers intact and replace only the request
// transport so this test exercises the real project-context resolution.
const realWorkerUtilsSnapshot = { ...realWorkerUtils };
const workerContextPaths: string[] = [];

mock.module('../../../src/shared/worker-utils.js', () => ({
  ...realWorkerUtilsSnapshot,
  executeWithWorkerFallback: async (path: string) => {
    workerContextPaths.push(path);
    return 'test context';
  },
}));

beforeEach(() => {
  workerContextPaths.length = 0;
});

afterAll(() => {
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
});

describe('userMessageHandler project context', () => {
  it('uses CLAUDE_MEM_PROJECT_ROOT instead of the nested hook cwd in its context request', async () => {
    const originalProjectRoot = process.env.CLAUDE_MEM_PROJECT_ROOT;

    try {
      process.env.CLAUDE_MEM_PROJECT_ROOT = '/workspace/MKS';
      const { userMessageHandler } = await import('../../../src/cli/handlers/user-message.js');

      await userMessageHandler.execute({
        sessionId: 'user-message-project-root-test',
        cwd: '/workspace/MKS/marketplace-api',
        platform: 'claude-code',
      });

      expect(workerContextPaths).toEqual([
        '/api/context/inject?project=MKS&colors=true&platformSource=claude',
      ]);
    } finally {
      if (originalProjectRoot === undefined) {
        delete process.env.CLAUDE_MEM_PROJECT_ROOT;
      } else {
        process.env.CLAUDE_MEM_PROJECT_ROOT = originalProjectRoot;
      }
    }
  });
});
