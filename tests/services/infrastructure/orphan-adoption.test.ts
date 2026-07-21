import { describe, it, expect, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';
import { scanOrphans } from '../../../src/services/infrastructure/OrphanAdoption.js';

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
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
}

function makeTemp(label: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), `claude-mem-${label}-`));
  tempRoots.push(root);
  // macOS hands out /var/... which symlinks to /private/var/...; git reports
  // the resolved path, so compare against the resolved one.
  return realpathSync(root);
}

/** A data dir with a schema-complete DB and a known-cwds registry. */
function makeDataDir(knownCwds: string[]): string {
  const dir = makeTemp('data');
  mkdirSync(path.join(dir, 'state'), { recursive: true });
  writeFileSync(
    path.join(dir, 'state', 'known-cwds.json'),
    JSON.stringify({ cwds: knownCwds, updatedAt: new Date().toISOString() }),
    'utf-8'
  );
  const db = new Database(path.join(dir, 'claude-mem.db'));
  db.run(`CREATE TABLE observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_session_id TEXT NOT NULL,
    project TEXT NOT NULL,
    created_at TEXT NOT NULL,
    merged_into_project TEXT,
    chroma_merge_synced_at INTEGER
  )`);
  db.run(`CREATE TABLE session_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_session_id TEXT NOT NULL,
    project TEXT NOT NULL,
    created_at TEXT NOT NULL,
    merged_into_project TEXT,
    chroma_merge_synced_at INTEGER
  )`);
  db.close();
  return dir;
}

function addRows(
  dataDir: string,
  project: string,
  obs: number,
  sums: number,
  createdAt = '2026-07-20T10:00:00.000Z'
): void {
  const db = new Database(path.join(dataDir, 'claude-mem.db'));
  for (let i = 0; i < obs; i++) {
    db.run('INSERT INTO observations (memory_session_id, project, created_at) VALUES (?, ?, ?)',
      [`s${i}`, project, createdAt]);
  }
  for (let i = 0; i < sums; i++) {
    db.run('INSERT INTO session_summaries (memory_session_id, project, created_at) VALUES (?, ?, ?)',
      [`s${i}`, project, createdAt]);
  }
  db.close();
}

/** Main repo plus a worktree, both real on disk. */
function makeRepoWithWorktree(repoName: string, worktreeName: string) {
  const parent = makeTemp('repo');
  const mainRepo = path.join(parent, repoName);
  spawnSync('git', ['init', '-b', 'main', mainRepo], { encoding: 'utf8', env: GIT_ENV });
  writeFileSync(path.join(mainRepo, 'f.txt'), 'x', 'utf-8');
  git(mainRepo, ['add', '.']);
  git(mainRepo, ['commit', '-m', 'init']);
  const worktree = path.join(parent, worktreeName);
  git(mainRepo, ['worktree', 'add', '-b', worktreeName, worktree]);
  return { mainRepo, worktree };
}

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe('scanOrphans', () => {
  it('classifies a project with a live worktree as live, not orphan', () => {
    const { mainRepo, worktree } = makeRepoWithWorktree('demo', 'feature-a');
    const dataDir = makeDataDir([mainRepo, worktree]);
    addRows(dataDir, 'demo/feature-a', 3, 1);

    const result = scanOrphans({ dataDirectory: dataDir });

    expect(result.orphans.map(o => o.project)).toEqual([]);
    expect(result.live.map(o => o.project)).toEqual(['demo/feature-a']);
    expect(result.live[0].observations).toBe(3);
    expect(result.live[0].summaries).toBe(1);
    expect(result.live[0].parentProject).toBe('demo');
  });

  it('classifies a project whose worktree was properly removed as an orphan', () => {
    const { mainRepo, worktree } = makeRepoWithWorktree('demo', 'feature-b');
    const dataDir = makeDataDir([mainRepo, worktree]);
    addRows(dataDir, 'demo/feature-b', 5, 2);
    git(mainRepo, ['worktree', 'remove', worktree]);

    const result = scanOrphans({ dataDirectory: dataDir });

    expect(result.orphans.map(o => o.project)).toEqual(['demo/feature-b']);
    expect(result.orphans[0].observations).toBe(5);
    expect(result.orphans[0].summaries).toBe(2);
  });

  it('treats an rm -rf worktree as dead even though git still lists it', () => {
    // `git worktree list` keeps showing the entry, flagged `prunable`, until
    // `git worktree prune` runs. Without an explicit check this orphan would
    // be classified live and never surface — the exact case this tool exists
    // for, since manual deletion bypasses the orca archive hook.
    const { mainRepo, worktree } = makeRepoWithWorktree('demo', 'feature-c');
    const dataDir = makeDataDir([mainRepo, worktree]);
    addRows(dataDir, 'demo/feature-c', 4, 0);
    rmSync(worktree, { recursive: true, force: true });

    // `existsSync` in `isLive` is the load-bearing check here, not the
    // `prunable` marker git attaches to the listing — see the comment on
    // `listWorktrees`.
    const result = scanOrphans({ dataDirectory: dataDir });

    expect(result.orphans.map(o => o.project)).toEqual(['demo/feature-c']);
  });

  it('does not call a live worktree an orphan when two repos share a basename', () => {
    // Project name is the repo's basename, so a second clone collides. If the
    // wrong repo wins the lookup, the other's live worktrees are absent from
    // its `git worktree list` and get reported as deleted.
    const first = makeRepoWithWorktree('samename', 'wt-one');
    const second = makeRepoWithWorktree('samename', 'wt-two');
    const dataDir = makeDataDir([
      first.mainRepo, first.worktree, second.mainRepo, second.worktree,
    ]);
    addRows(dataDir, 'samename/wt-one', 1, 0);
    addRows(dataDir, 'samename/wt-two', 2, 0);

    const result = scanOrphans({ dataDirectory: dataDir });

    expect(result.orphans.map(o => o.project)).toEqual([]);
    expect(result.live.map(o => o.project).sort()).toEqual(['samename/wt-one', 'samename/wt-two']);
    expect(result.ambiguousParents).toContain('samename');
  });

  it('skips a project whose parent repo cannot be resolved', () => {
    const dataDir = makeDataDir([]);
    addRows(dataDir, 'ghost-repo/some-worktree', 7, 1);

    const result = scanOrphans({ dataDirectory: dataDir });

    expect(result.orphans).toEqual([]);
    expect(result.live).toEqual([]);
    expect(result.skipped.map(s => s.project)).toEqual(['ghost-repo/some-worktree']);
  });

  it('resolves the parent from an explicit repoPath when the registry is empty', () => {
    const { mainRepo, worktree } = makeRepoWithWorktree('demo', 'feature-d');
    const dataDir = makeDataDir([]);
    addRows(dataDir, 'demo/feature-d', 3, 0);
    git(mainRepo, ['worktree', 'remove', worktree]);

    const result = scanOrphans({ dataDirectory: dataDir, repoPath: mainRepo });

    expect(result.orphans.map(o => o.project)).toEqual(['demo/feature-d']);
    expect(result.skipped).toEqual([]);
  });

  it('augments the registry with --repo instead of replacing it', () => {
    // A project resolvable only via the registry, and one resolvable only
    // via the explicit repoPath — both must be classified, neither skipped.
    const registryRepo = makeRepoWithWorktree('registry-only', 'feature-f');
    const explicitRepo = makeRepoWithWorktree('explicit-only', 'feature-g');
    const dataDir = makeDataDir([registryRepo.mainRepo, registryRepo.worktree]);
    addRows(dataDir, 'registry-only/feature-f', 1, 0);
    addRows(dataDir, 'explicit-only/feature-g', 1, 0);

    const result = scanOrphans({ dataDirectory: dataDir, repoPath: explicitRepo.mainRepo });

    expect(result.skipped).toEqual([]);
    expect(result.live.map(o => o.project).sort()).toEqual([
      'explicit-only/feature-g',
      'registry-only/feature-f',
    ]);
  });

  it('ignores rows that are already adopted', () => {
    const { mainRepo, worktree } = makeRepoWithWorktree('demo', 'feature-e');
    const dataDir = makeDataDir([mainRepo, worktree]);
    addRows(dataDir, 'demo/feature-e', 2, 0);
    git(mainRepo, ['worktree', 'remove', worktree]);
    const db = new Database(path.join(dataDir, 'claude-mem.db'));
    db.run("UPDATE observations SET merged_into_project = 'demo'");
    db.close();

    const result = scanOrphans({ dataDirectory: dataDir });

    expect(result.orphans).toEqual([]);
  });
});
