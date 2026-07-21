import { describe, it, expect, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';
import {
  scanOrphans,
  readDeclines, recordDecline, resetDeclines, isSuppressed,
  adoptOrphan,
  type OrphanCandidate,
} from '../../../src/services/infrastructure/OrphanAdoption.js';

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
    // `git worktree prune` runs — so presence in that listing does not mean
    // the worktree is live. Manual deletion bypasses the orca archive hook,
    // which makes this the case the tool exists for.
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

  it('orders orphans by lastSeen, newest first', () => {
    // scanOrphans reads readUnadoptedProjects' `ORDER BY lastSeen DESC` and
    // pushes into result.orphans without re-sorting — this pins that order,
    // since Task 4's CLI prints result.orphans directly to the user.
    const first = makeRepoWithWorktree('demo', 'feature-h');
    const second = makeRepoWithWorktree('other', 'feature-i');
    const dataDir = makeDataDir([
      first.mainRepo, first.worktree, second.mainRepo, second.worktree,
    ]);
    addRows(dataDir, 'demo/feature-h', 1, 0, '2020-01-01T00:00:00.000Z');
    addRows(dataDir, 'other/feature-i', 1, 0, '2026-07-20T00:00:00.000Z');
    git(first.mainRepo, ['worktree', 'remove', first.worktree]);
    git(second.mainRepo, ['worktree', 'remove', second.worktree]);

    const result = scanOrphans({ dataDirectory: dataDir });

    expect(result.orphans.map(o => o.project)).toEqual(['other/feature-i', 'demo/feature-h']);
  });
});

describe('decline store', () => {
  // firstSeen and lastSeen default to distinct values so a test can never
  // accidentally pass regardless of which field isSuppressed reads.
  const candidate = (
    project: string,
    lastSeen: string,
    firstSeen = '2000-01-01T00:00:00.000Z'
  ): OrphanCandidate => ({
    project, parentProject: 'demo', observations: 1, summaries: 0,
    firstSeen, lastSeen,
  });

  it('suppresses a declined project whose rows are all older than the decline', () => {
    const dataDir = makeDataDir([]);
    recordDecline('demo/old-thing', dataDir);
    const declines = readDeclines(dataDir);

    expect(isSuppressed(candidate('demo/old-thing', '2020-01-01T00:00:00.000Z'), declines)).toBe(true);
  });

  it('re-surfaces a declined project once newer rows appear', () => {
    // Worktree names are reused (api-reanimation, dropdown-primevue are not
    // random). A decline keyed only by name would permanently hide the memory
    // of a NEW worktree that happens to reuse the name.
    //
    // firstSeen is deliberately OLD (predates the decline) while lastSeen is
    // NEW — this pins that isSuppressed reads lastSeen, not firstSeen. A
    // project whose firstSeen predates the decline must still re-surface once
    // fresh rows arrive.
    const dataDir = makeDataDir([]);
    recordDecline('demo/reused-name', dataDir);
    const declines = readDeclines(dataDir);

    expect(isSuppressed(
      candidate('demo/reused-name', '2099-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z'),
      declines
    )).toBe(false);
  });

  it('does not suppress a project that was never declined', () => {
    const dataDir = makeDataDir([]);
    const declines = readDeclines(dataDir);

    expect(isSuppressed(candidate('demo/fresh', '2026-07-20T00:00:00.000Z'), declines)).toBe(false);
  });

  it('resetDeclines clears every decline', () => {
    const dataDir = makeDataDir([]);
    recordDecline('demo/a', dataDir);
    recordDecline('demo/b', dataDir);
    resetDeclines(dataDir);

    expect(readDeclines(dataDir).size).toBe(0);
  });

  it('treats a corrupt decline file as empty (fail-open)', () => {
    // Asking once too often is safe; silently hiding an orphan is the failure
    // this whole tool exists to prevent.
    const dataDir = makeDataDir([]);
    mkdirSync(path.join(dataDir, 'state'), { recursive: true });
    writeFileSync(path.join(dataDir, 'state', 'orphan-decisions.json'), '{ not json', 'utf-8');

    expect(readDeclines(dataDir).size).toBe(0);
  });

  it('does not suppress when the decline `at` is not a parseable timestamp (fail-open)', () => {
    // A garbage `at` that is still valid JSON with the right shape is kept by
    // readDeclines (it doesn't validate the timestamp). The defense lives in
    // isSuppressed instead: comparing candidate.lastSeen <= declinedAt as
    // plain strings would suppress forever, since any string starting with a
    // letter ('garbage') sorts above every ISO timestamp (which starts with a
    // digit). isSuppressed parses both sides and fails open when either is
    // unparseable, so the project is asked about again.
    const dataDir = makeDataDir([]);
    mkdirSync(path.join(dataDir, 'state'), { recursive: true });
    writeFileSync(
      path.join(dataDir, 'state', 'orphan-decisions.json'),
      JSON.stringify({ declined: [{ project: 'demo/bad-timestamp', at: 'garbage' }] }),
      'utf-8'
    );
    const declines = readDeclines(dataDir);

    expect(isSuppressed(candidate('demo/bad-timestamp', '2026-07-20T00:00:00.000Z'), declines)).toBe(false);
  });

  it('does not suppress a newer SQLite-style lastSeen against an ISO decline', () => {
    // The DB-derived operand is `lastSeen` (MAX(created_at)); `at` is always
    // written by recordDecline via toISOString(). So the format risk lives on
    // lastSeen: if a future writer ever stored `datetime('now')` values
    // ("2026-07-21 06:36:37", space-separated, no `Z`), a raw string compare
    // suppresses that project forever, because space (0x20) sorts below `T`
    // (0x54) — making a genuinely NEWER row compare as older than the decline.
    //
    // The date parts must match so the comparison actually reaches that byte:
    // with differing days it resolves earlier and the test proves nothing.
    // Verified both directions — reverting isSuppressed to a raw string
    // compare makes this test fail.
    const dataDir = makeDataDir([]);
    writeFileSync(
      path.join(dataDir, 'state', 'orphan-decisions.json'),
      JSON.stringify({ declined: [{ project: 'demo/sqlite-style', at: '2026-07-21T00:00:00.000Z' }] }),
      'utf-8'
    );
    const declines = readDeclines(dataDir);

    expect(isSuppressed(candidate('demo/sqlite-style', '2026-07-21 06:36:37'), declines)).toBe(false);
  });

  it('suppresses a candidate whose lastSeen exactly equals the decline timestamp', () => {
    // A row created in the same millisecond as the decline was already part
    // of what the user was shown, so <= (not <) is correct: it must still be
    // suppressed. Written directly rather than via recordDecline, which
    // stamps Date.now() and can't be pinned to an exact value.
    const dataDir = makeDataDir([]);
    mkdirSync(path.join(dataDir, 'state'), { recursive: true });
    const at = '2026-07-20T12:00:00.000Z';
    writeFileSync(
      path.join(dataDir, 'state', 'orphan-decisions.json'),
      JSON.stringify({ declined: [{ project: 'demo/boundary', at }] }),
      'utf-8'
    );
    const declines = readDeclines(dataDir);

    expect(isSuppressed(candidate('demo/boundary', at), declines)).toBe(true);
  });
});

describe('adoptOrphan', () => {
  it('sets merged_into_project and queues both tables for the Chroma drain', () => {
    const dataDir = makeDataDir([]);
    addRows(dataDir, 'demo/gone', 3, 2);
    const db = new Database(path.join(dataDir, 'claude-mem.db'));
    db.run('UPDATE observations SET chroma_merge_synced_at = 111');
    db.run('UPDATE session_summaries SET chroma_merge_synced_at = 222');
    db.close();

    const changed = adoptOrphan('demo/gone', 'demo', { dataDirectory: dataDir });

    expect(changed).toEqual({ observations: 3, summaries: 2 });

    const check = new Database(path.join(dataDir, 'claude-mem.db'));
    const obs = check.prepare(
      "SELECT COUNT(*) n FROM observations WHERE merged_into_project = 'demo' AND chroma_merge_synced_at IS NULL"
    ).get() as { n: number };
    const sums = check.prepare(
      "SELECT COUNT(*) n FROM session_summaries WHERE merged_into_project = 'demo' AND chroma_merge_synced_at IS NULL"
    ).get() as { n: number };
    check.close();

    expect(obs.n).toBe(3);
    expect(sums.n).toBe(2);
  });

  it('is idempotent — a second run changes nothing', () => {
    const dataDir = makeDataDir([]);
    addRows(dataDir, 'demo/gone', 4, 1);

    adoptOrphan('demo/gone', 'demo', { dataDirectory: dataDir });
    const second = adoptOrphan('demo/gone', 'demo', { dataDirectory: dataDir });

    expect(second).toEqual({ observations: 0, summaries: 0 });
  });

  it('leaves other projects untouched', () => {
    const dataDir = makeDataDir([]);
    addRows(dataDir, 'demo/gone', 2, 0);
    addRows(dataDir, 'demo/still-here', 3, 0);

    adoptOrphan('demo/gone', 'demo', { dataDirectory: dataDir });

    const check = new Database(path.join(dataDir, 'claude-mem.db'));
    const untouched = check.prepare(
      "SELECT COUNT(*) n FROM observations WHERE project = 'demo/still-here' AND merged_into_project IS NULL"
    ).get() as { n: number };
    check.close();

    expect(untouched.n).toBe(3);
  });
});
