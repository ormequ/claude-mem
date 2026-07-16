import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';
import { adoptMergedWorktreesForAllKnownRepos } from '../../../src/services/infrastructure/WorktreeAdoption.js';
import {
  recordCwd,
  resetKnownCwdRegistryCacheForTesting,
} from '../../../src/services/infrastructure/KnownCwdRegistry.js';

// The regression this pins (measured 2026-07-16): repo discovery read
// `pending_messages.cwd`, a queue whose rows are deleted the moment an
// observation is processed. With the queue drained — its normal state — this
// function resolved zero parent repos and returned an empty list at a
// `logger.debug` line that never reaches the log file. Both the worker-boot
// pass and the hourly AdoptionScheduler tick were silently dead, so a merged
// worktree stayed invisible to parent-project queries until someone ran the
// `adopt` CLI by hand.
//
// Every test here therefore leaves pending_messages EMPTY. On the pre-fix
// code they all fail with `results.length === 0`.

const tempRoots: string[] = [];

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'claude-mem test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'claude-mem test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(cwd: string, args: string[]): void {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
}

function makeTemp(label: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), `claude-mem-${label}-`));
  tempRoots.push(root);
  // macOS hands out /var/... which is a symlink to /private/var/...; git
  // reports the resolved path, so compare against the resolved one.
  return realpathSync(root);
}

/**
 * A main repo on `main` with `feature` merged into it, plus a worktree that
 * still has `feature` checked out — the exact shape adoption looks for.
 */
function makeRepoWithMergedWorktree(): { mainRepo: string; worktree: string } {
  const parent = makeTemp('repo');
  const mainRepo = path.join(parent, 'demo-repo');
  spawnSync('git', ['init', '-b', 'main', mainRepo], { encoding: 'utf8', env: GIT_ENV });

  spawnSync('bash', ['-c', `echo one > "${mainRepo}/file.txt"`]);
  git(mainRepo, ['add', '-A']);
  git(mainRepo, ['commit', '-m', 'initial']);

  git(mainRepo, ['branch', 'feature']);
  const worktree = path.join(parent, 'demo-worktree');
  git(mainRepo, ['worktree', 'add', worktree, 'feature']);

  spawnSync('bash', ['-c', `echo two > "${worktree}/feature.txt"`]);
  git(worktree, ['add', '-A']);
  git(worktree, ['commit', '-m', 'feature work']);

  // Merge feature into main so `git branch --merged HEAD` reports it.
  git(mainRepo, ['merge', '--no-ff', '-m', 'merge feature', 'feature']);

  return { mainRepo, worktree };
}

/**
 * A data dir whose DB carries the tables adoption probes, with
 * pending_messages deliberately EMPTY.
 */
function makeDataDir(): string {
  const dataDir = makeTemp('data');
  const db = new Database(path.join(dataDir, 'claude-mem.db'));
  db.run(`CREATE TABLE pending_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cwd TEXT,
    status TEXT
  )`);
  db.run(`CREATE TABLE observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT,
    merged_into_project TEXT
  )`);
  db.run(`CREATE TABLE session_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT,
    merged_into_project TEXT
  )`);
  db.close();
  return dataDir;
}

afterAll(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('adoptMergedWorktreesForAllKnownRepos repo discovery', () => {
  beforeEach(() => {
    resetKnownCwdRegistryCacheForTesting();
  });

  it('finds a repo from the durable registry when the message queue is empty', async () => {
    const dataDir = makeDataDir();
    const { worktree } = makeRepoWithMergedWorktree();
    recordCwd(worktree, dataDir);

    const results = await adoptMergedWorktreesForAllKnownRepos({
      dataDirectory: dataDir,
      dryRun: true,
    });

    expect(results).toHaveLength(1);
    expect(results[0].mergedBranches).toContain('feature');
  });

  it('resolves a worktree cwd to its main repo rather than the worktree itself', async () => {
    const dataDir = makeDataDir();
    const { mainRepo, worktree } = makeRepoWithMergedWorktree();
    recordCwd(worktree, dataDir);

    const results = await adoptMergedWorktreesForAllKnownRepos({
      dataDirectory: dataDir,
      dryRun: true,
    });

    expect(results[0].repoPath).toBe(mainRepo);
    expect(results[0].parentProject).toBe(path.basename(mainRepo));
  });

  it('does not rediscover a repo whose worktree directory is gone', async () => {
    const dataDir = makeDataDir();
    const { worktree } = makeRepoWithMergedWorktree();
    recordCwd(worktree, dataDir);
    rmSync(worktree, { recursive: true, force: true });

    resetKnownCwdRegistryCacheForTesting();
    const results = await adoptMergedWorktreesForAllKnownRepos({
      dataDirectory: dataDir,
      dryRun: true,
    });

    expect(results).toEqual([]);
  });

  it('deduplicates two worktrees of the same repo into one adoption pass', async () => {
    const dataDir = makeDataDir();
    const { mainRepo, worktree } = makeRepoWithMergedWorktree();
    const second = path.join(path.dirname(mainRepo), 'second-worktree');
    git(mainRepo, ['branch', 'other']);
    git(mainRepo, ['worktree', 'add', second, 'other']);

    recordCwd(worktree, dataDir);
    recordCwd(second, dataDir);

    const results = await adoptMergedWorktreesForAllKnownRepos({
      dataDirectory: dataDir,
      dryRun: true,
    });

    expect(results).toHaveLength(1);
    expect(results[0].repoPath).toBe(mainRepo);
  });
});
