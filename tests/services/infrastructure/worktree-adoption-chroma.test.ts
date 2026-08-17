import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import * as realChromaMcpManager from '../../../src/services/sync/ChromaMcpManager.js';

const chromaCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
const realChromaMcpManagerSnapshot = { ...realChromaMcpManager };

mock.module('../../../src/services/sync/ChromaMcpManager.js', () => ({
  ChromaMcpManager: {
    getInstance: () => ({
      callTool: async (name: string, args: Record<string, unknown>) => {
        chromaCalls.push({ name, args });
        if (name === 'chroma_create_collection') return {};
        if (name === 'chroma_get_documents') {
          return {
            ids: ['summary_1_request'],
            metadatas: [{ sqlite_id: 1, doc_type: 'session_summary' }]
          };
        }
        return {};
      }
    })
  }
}));

import { adoptMergedWorktrees } from '../../../src/services/infrastructure/WorktreeAdoption.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

let tempRoot: string | undefined;
let mainRepoForCleanup: string | undefined;

afterEach(() => {
  chromaCalls.length = 0;
  if (mainRepoForCleanup && existsSync(mainRepoForCleanup)) {
    try { git(mainRepoForCleanup, 'worktree', 'remove', '--force', path.join(tempRoot!, 'summary-worktree')); } catch {}
  }
  if (tempRoot) {
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  }
  tempRoot = undefined;
  mainRepoForCleanup = undefined;
});

afterAll(() => {
  mock.module('../../../src/services/sync/ChromaMcpManager.js', () => realChromaMcpManagerSnapshot);
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

describe('worktree adoption Chroma hydration', () => {
  it('patches a session-summary document when the adopted worktree has no observations', async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-3331-'));
    const mainRepo = path.join(tempRoot, 'parent-repo');
    mainRepoForCleanup = mainRepo;
    const worktree = path.join(tempRoot, 'summary-worktree');
    const dataDirectory = path.join(tempRoot, 'data');
    mkdirSync(mainRepo, { recursive: true });
    mkdirSync(dataDirectory);

    git(mainRepo, 'init', '-b', 'main');
    git(mainRepo, 'config', 'user.email', 'test@example.com');
    git(mainRepo, 'config', 'user.name', 'Test');
    writeFileSync(path.join(mainRepo, 'README.md'), 'base\n');
    git(mainRepo, 'add', 'README.md');
    git(mainRepo, 'commit', '-m', 'base');
    git(mainRepo, 'worktree', 'add', '-b', 'feature', worktree);

    const dbPath = path.join(dataDirectory, 'claude-mem.db');
    const store = new SessionStore(dbPath);
    const sdkSessionId = store.createSDKSession('content-summary', 'parent-repo/summary-worktree', 'prompt');
    store.ensureMemorySessionIdRegistered(sdkSessionId, 'summary-session');
    const summary = store.importSessionSummary({
      memory_session_id: 'summary-session',
      project: 'parent-repo/summary-worktree',
      request: 'summary only',
      investigated: null,
      learned: null,
      completed: null,
      next_steps: null,
      files_read: null,
      files_edited: null,
      notes: null,
      prompt_number: 1,
      discovery_tokens: 0,
      created_at: new Date(1_700_000_000_000).toISOString(),
      created_at_epoch: 1_700_000_000_000,
    });
    store.close();

    const result = await adoptMergedWorktrees({
      repoPath: mainRepo,
      dataDirectory,
      onlyBranch: 'feature'
    });

    const verify = new SessionStore(dbPath);
    const row = verify.db.prepare(
      'SELECT merged_into_project, chroma_merge_synced_at FROM session_summaries WHERE id = ?'
    ).get(summary.id) as { merged_into_project: string; chroma_merge_synced_at: number | null };
    verify.close();

    expect(result.adoptedObservations).toBe(0);
    expect(result.adoptedSummaries).toBe(1);
    expect(row.merged_into_project).toBe('parent-repo');
    // FORK (#3331 equivalent): a summary-only adoption must still reach Chroma,
    // but adoption never opens a Chroma writer itself — the CLI process can't
    // take the single-writer lock the worker holds. It queues the row
    // (chroma_merge_synced_at = NULL) for the worker's ChromaMergeDrain.
    // See FORK_NOTES.md → "Chroma merge-patch".
    expect(row.chroma_merge_synced_at).toBeNull();
    expect(result.chromaQueued).toBe(1);
    expect(chromaCalls).toEqual([]);
  });

  it('does not point a worktree at itself when the project root override collapses both names', async () => {
    // CLAUDE_MEM_PROJECT_ROOT makes every checkout of an umbrella report the same
    // project name, so worktree and parent resolve identically. Adopting then
    // writes merged_into_project = project: invisible to reads, but it queues the
    // row for a Chroma patch that changes nothing, forever.
    tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-self-'));
    const mainRepo = path.join(tempRoot, 'parent-repo');
    mainRepoForCleanup = mainRepo;
    const worktree = path.join(tempRoot, 'summary-worktree');
    const dataDirectory = path.join(tempRoot, 'data');
    mkdirSync(mainRepo, { recursive: true });
    mkdirSync(dataDirectory);

    git(mainRepo, 'init', '-b', 'main');
    git(mainRepo, 'config', 'user.email', 'test@example.com');
    git(mainRepo, 'config', 'user.name', 'Test');
    writeFileSync(path.join(mainRepo, 'README.md'), 'base\n');
    git(mainRepo, 'add', 'README.md');
    git(mainRepo, 'commit', '-m', 'base');
    git(mainRepo, 'worktree', 'add', '-b', 'feature', worktree);

    const dbPath = path.join(dataDirectory, 'claude-mem.db');
    const store = new SessionStore(dbPath);
    const sdkSessionId = store.createSDKSession('content-self', 'parent-repo', 'prompt');
    store.ensureMemorySessionIdRegistered(sdkSessionId, 'self-session');
    const summary = store.importSessionSummary({
      memory_session_id: 'self-session',
      project: 'parent-repo',
      request: 'umbrella work',
      investigated: null,
      learned: null,
      completed: null,
      next_steps: null,
      files_read: null,
      files_edited: null,
      notes: null,
      prompt_number: 1,
      discovery_tokens: 0,
      created_at: new Date(1_700_000_000_000).toISOString(),
      created_at_epoch: 1_700_000_000_000,
    });
    store.close();

    const previousRoot = process.env.CLAUDE_MEM_PROJECT_ROOT;
    process.env.CLAUDE_MEM_PROJECT_ROOT = mainRepo;
    let result;
    try {
      result = await adoptMergedWorktrees({
        repoPath: mainRepo,
        dataDirectory,
        onlyBranch: 'feature'
      });
    } finally {
      if (previousRoot === undefined) delete process.env.CLAUDE_MEM_PROJECT_ROOT;
      else process.env.CLAUDE_MEM_PROJECT_ROOT = previousRoot;
    }

    const verify = new SessionStore(dbPath);
    const row = verify.db.prepare(
      'SELECT merged_into_project FROM session_summaries WHERE id = ?'
    ).get(summary.id) as { merged_into_project: string | null };
    verify.close();

    expect(row.merged_into_project).toBeNull();
    expect(result.adoptedSummaries).toBe(0);
    expect(result.chromaQueued).toBe(0);
  });
});
