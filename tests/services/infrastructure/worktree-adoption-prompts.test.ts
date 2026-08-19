// FORK: prompts carry no project of their own — they resolve through
// sdk_sessions.project. Adoption used to move observations and summaries to the
// parent while the session (and therefore its prompts) stayed on the worktree
// label, so a project-scoped read saw the observations without the prompts that
// produced them.
import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { adoptMergedWorktrees } from '../../../src/services/infrastructure/WorktreeAdoption.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';

let tempRoot: string | undefined;
let mainRepoForCleanup: string | undefined;

afterEach(() => {
  if (mainRepoForCleanup && existsSync(mainRepoForCleanup)) {
    try { git(mainRepoForCleanup, 'worktree', 'remove', '--force', path.join(tempRoot!, 'prompt-worktree')); } catch {}
  }
  if (tempRoot) {
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  }
  tempRoot = undefined;
  mainRepoForCleanup = undefined;
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

describe('worktree adoption prompt attribution', () => {
  it('moves the session pointer so the parent project sees the adopted prompts', async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-prompts-'));
    const mainRepo = path.join(tempRoot, 'parent-repo');
    mainRepoForCleanup = mainRepo;
    const worktree = path.join(tempRoot, 'prompt-worktree');
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

    const worktreeProject = 'parent-repo/prompt-worktree';
    const dbPath = path.join(dataDirectory, 'claude-mem.db');
    const store = new SessionStore(dbPath);
    const sessionDbId = store.createSDKSession('content-prompt', worktreeProject, 'first prompt');
    store.ensureMemorySessionIdRegistered(sessionDbId, 'prompt-session');
    const promptId = store.saveUserPrompt('content-prompt', 1, 'why does adoption drop my prompts', sessionDbId);
    store.close();

    const before = new SessionStore(dbPath);
    expect(before.getUserPromptsByIds([promptId], { project: 'parent-repo' })).toHaveLength(0);
    before.close();

    const result = await adoptMergedWorktrees({
      repoPath: mainRepo,
      dataDirectory,
      onlyBranch: 'feature'
    });

    expect(result.adoptedSessions).toBe(1);

    const verify = new SessionStore(dbPath);
    const row = verify.db.prepare(
      'SELECT project, merged_into_project FROM sdk_sessions WHERE id = ?'
    ).get(sessionDbId) as { project: string; merged_into_project: string | null };
    // The raw label is preserved, exactly like observations — adoption is a
    // pointer, not a rewrite.
    expect(row.project).toBe(worktreeProject);
    expect(row.merged_into_project).toBe('parent-repo');

    // Both prompt read paths now resolve under the parent project.
    expect(verify.getUserPromptsByIds([promptId], { project: 'parent-repo' })).toHaveLength(1);
    const search = new SessionSearch(verify.db);
    expect(search.searchUserPrompts(undefined, { project: 'parent-repo' })).toHaveLength(1);
    verify.close();
  });
});
