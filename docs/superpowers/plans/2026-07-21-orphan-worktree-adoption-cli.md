# Orphan Worktree Adoption CLI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `adopt-mem --orphans` — an interactive CLI that finds claude-mem memory rows belonging to deleted git worktrees and adopts them into their parent project after human approval.

**Architecture:** A fork-owned module (`OrphanAdoption.ts`) does detection, classification and the SQLite UPDATE; a thin script (`adopt-orphans.ts`) does TTY prompting and formatting; `scripts/adopt-mem` gains an `--orphans` branch that delegates to it. No upstream file is touched.

**Tech Stack:** TypeScript, Bun (`bun:sqlite`, `bun:test`), git CLI via `child_process.spawnSync`.

**Spec:** `docs/superpowers/specs/2026-07-21-orphan-worktree-adoption-cli-design.md`

## Global Constraints

- **Minimal upstream diff — ONE exception, granted by the owner 2026-07-21.**
  The only permitted edit to an upstream file is adding the `export` keyword to
  two existing functions in `src/services/infrastructure/WorktreeAdoption.ts`:
  `gitCapture` and `resolveMainRepoPath`. Nothing else about them changes — no
  signature, no body, no reordering.
  **`listWorktrees` is explicitly NOT exported and NOT modified.** Its upstream
  body does not parse the `prunable` attribute (`WorktreeAdoption.ts:84-105`),
  and teaching it to would be a behavioral change to upstream logic — far more
  expensive at merge time than the duplication it saves. This module ships its
  own `listWorktrees` that parses `prunable`.
  No other upstream file may be touched: not `src/services/worker-service.ts`,
  not `src/npx-cli/**`, not anything else present on `origin/main`.
  Verify before committing: `git diff origin/main -- src/services/infrastructure/WorktreeAdoption.ts`
  must show exactly two changed lines, each adding only the word `export`.
- **Never open a Chroma writer.** Adoption only sets SQLite state. The worker patches Chroma from the `chroma_merge_synced_at IS NULL` queue. A second writer over the same store is the 2026-07-11 incident (`FORK_NOTES.md:313-338`).
- **One metric everywhere:** counts shown to the user are `observations + summaries`.
- **Run tests with the sandbox disabled** — it denies reads of `./node_modules`, so imports die at module resolution and read as a code failure (`FORK_NOTES.md:360-363`).
- Parent project name is the substring of `project` before the first `/`. Composite names are built as `basename(parent)/basename(cwd)` (`src/utils/worktree.ts:57-59`), so a basename can never contain `/`.
- Adoption UPDATEs must carry `AND merged_into_project IS NULL` for idempotency.

---

### Task 1: Worktree liveness and orphan classification

The core detection. A worktree entry counts as live only if its directory exists **and** git did not mark it `prunable` — `git worktree list` keeps showing a directory removed with `rm -rf` until `git worktree prune` runs.

**Files:**
- Create: `src/services/infrastructure/OrphanAdoption.ts`
- Test: `tests/services/infrastructure/orphan-adoption.test.ts`

**Interfaces:**
- Consumes: `openConfiguredSqliteDatabase(dbPath)` from `src/services/sqlite/connection.js`; `getProjectContext(cwd)` from `src/utils/project-name.js` (returns `{ primary, parent, isWorktree, allProjects }`); `listKnownCwds(dataDirectory?)` from `src/services/infrastructure/KnownCwdRegistry.js`; `paths.dataDir()` from `src/shared/paths.js`.
- Produces:
  - `interface OrphanCandidate { project: string; parentProject: string; observations: number; summaries: number; firstSeen: string; lastSeen: string }`
  - `interface OrphanScanResult { orphans: OrphanCandidate[]; live: OrphanCandidate[]; skipped: Array<{ project: string; reason: string }>; ambiguousParents: string[] }`
  - `function scanOrphans(opts?: { dataDirectory?: string; repoPath?: string }): OrphanScanResult`

- [ ] **Step 1: Write the failing test**

Create `tests/services/infrastructure/orphan-adoption.test.ts`:

```typescript
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

    const listing = spawnSync('git', ['-C', mainRepo, 'worktree', 'list', '--porcelain'],
      { encoding: 'utf8', env: GIT_ENV }).stdout;
    expect(listing).toContain('prunable');   // pin the git behavior we rely on

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
    addRows(dataDir, 'samename/wt-two', 2, 0);

    const result = scanOrphans({ dataDirectory: dataDir });

    expect(result.orphans.map(o => o.project)).toEqual([]);
    expect(result.live.map(o => o.project)).toEqual(['samename/wt-two']);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/services/infrastructure/orphan-adoption.test.ts`
Expected: FAIL — `Cannot find module '../../../src/services/infrastructure/OrphanAdoption.js'`

Run with the sandbox disabled.

- [ ] **Step 3a: Export the two reusable helpers from upstream**

This is the single permitted upstream edit (see Global Constraints). In
`src/services/infrastructure/WorktreeAdoption.ts`, add the `export` keyword to
exactly these two declarations — change nothing else about them:

```typescript
export function gitCapture(cwd: string, args: string[]): string | null {
```

```typescript
export function resolveMainRepoPath(cwd: string): string | null {
```

Do **not** export or modify `listWorktrees` — its body does not parse the
`prunable` attribute, and changing that is an upstream behavioral delta this
plan refuses to pay.

Verify the edit is exactly two words:

Run: `git diff origin/main -- src/services/infrastructure/WorktreeAdoption.ts`
Expected: two changed lines, each differing only by a leading `export `.

- [ ] **Step 3b: Write minimal implementation**

Create `src/services/infrastructure/OrphanAdoption.ts`:

```typescript
// FORK-OWNED: review and adoption of memory rows left behind by DELETED
// worktrees.
//
// Why this exists: every adoption path (worker boot, AdoptionScheduler tick,
// the `adopt` CLI) enumerates candidates from `git worktree list`
// (WorktreeAdoption.ts:179). A worktree that no longer exists is therefore
// invisible to all of them, and its rows keep `merged_into_project IS NULL`
// forever — permanently hidden from parent-project queries. Measured
// 2026-07-20: 8 such projects, 3886 rows.
//
// This module never decides whether a branch was merged. Adoption on deletion
// is unconditional by design (`--branch` skips the merged-check entirely,
// WorktreeAdoption.ts:188-190), so the tool presents facts and a human
// approves.
import path from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { paths } from '../../shared/paths.js';
import { getProjectContext } from '../../utils/project-name.js';
import { openConfiguredSqliteDatabase } from '../sqlite/connection.js';
import { listKnownCwds } from './KnownCwdRegistry.js';

import { gitCapture, resolveMainRepoPath } from './WorktreeAdoption.js';

export interface OrphanCandidate {
  project: string;
  parentProject: string;
  observations: number;
  summaries: number;
  firstSeen: string;
  lastSeen: string;
}

export interface OrphanScanResult {
  orphans: OrphanCandidate[];
  live: OrphanCandidate[];
  skipped: Array<{ project: string; reason: string }>;
  ambiguousParents: string[];
}

interface WorktreeEntry {
  path: string;
  prunable: boolean;
}

/**
 * Worktrees of `mainRepo`, carrying git's `prunable` marker.
 *
 * The marker matters: a worktree deleted with `rm -rf` (rather than
 * `git worktree remove`) stays in this listing until `git worktree prune`
 * runs, flagged `prunable gitdir file points to non-existent location`.
 * Treating such an entry as live would hide exactly the orphans this module
 * is built to surface.
 */
function listWorktrees(mainRepo: string): WorktreeEntry[] {
  const raw = gitCapture(mainRepo, ['worktree', 'list', '--porcelain']);
  if (!raw) return [];

  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};
  const flush = () => {
    if (current.path) entries.push({ path: current.path, prunable: current.prunable ?? false });
  };
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      current = { path: line.slice('worktree '.length).trim(), prunable: false };
    } else if (line.startsWith('prunable')) {
      current.prunable = true;
    } else if (line === '' && current.path) {
      flush();
      current = {};
    }
  }
  flush();
  return entries;
}

function isLive(entry: WorktreeEntry): boolean {
  return !entry.prunable && existsSync(entry.path);
}

/**
 * parent project name -> every repo root that produces that name.
 *
 * A set, not a single path: the project name is the repo's basename, so a
 * second clone or a backup collides. Resolving to one arbitrary winner would
 * make the loser's live worktrees look deleted.
 */
function resolveParentRepos(dataDirectory: string, repoPath?: string): Map<string, Set<string>> {
  const byName = new Map<string, Set<string>>();
  const seeds = repoPath ? [repoPath] : listKnownCwds(dataDirectory);
  for (const cwd of seeds) {
    const root = resolveMainRepoPath(cwd);
    if (!root) continue;
    const name = getProjectContext(root).primary;
    if (!byName.has(name)) byName.set(name, new Set());
    byName.get(name)!.add(root);
  }
  return byName;
}

interface ProjectRow {
  project: string;
  observations: number;
  summaries: number;
  firstSeen: string;
  lastSeen: string;
}

function readUnadoptedProjects(dbPath: string): ProjectRow[] {
  const db = openConfiguredSqliteDatabase(dbPath);
  try {
    return db.prepare(`
      SELECT project,
             SUM(obs) AS observations,
             SUM(sums) AS summaries,
             MIN(first_seen) AS firstSeen,
             MAX(last_seen) AS lastSeen
      FROM (
        SELECT project, COUNT(*) AS obs, 0 AS sums,
               MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
        FROM observations WHERE merged_into_project IS NULL GROUP BY project
        UNION ALL
        SELECT project, 0 AS obs, COUNT(*) AS sums,
               MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
        FROM session_summaries WHERE merged_into_project IS NULL GROUP BY project
      )
      WHERE project LIKE '%/%'
      GROUP BY project
      ORDER BY lastSeen DESC
    `).all() as ProjectRow[];
  } finally {
    db.close();
  }
}

export function scanOrphans(opts: { dataDirectory?: string; repoPath?: string } = {}): OrphanScanResult {
  const dataDirectory = opts.dataDirectory ?? paths.dataDir();
  const dbPath = path.join(dataDirectory, 'claude-mem.db');

  const result: OrphanScanResult = { orphans: [], live: [], skipped: [], ambiguousParents: [] };
  if (!existsSync(dbPath)) return result;

  const parentRepos = resolveParentRepos(dataDirectory, opts.repoPath);
  for (const [name, roots] of parentRepos) {
    if (roots.size > 1) result.ambiguousParents.push(name);
  }

  // parent name -> every live worktree project name across all repos of that name
  const liveByParent = new Map<string, Set<string>>();
  for (const [name, roots] of parentRepos) {
    const live = new Set<string>();
    for (const root of roots) {
      for (const entry of listWorktrees(root)) {
        if (entry.path === root || !isLive(entry)) continue;
        live.add(getProjectContext(entry.path).primary);
      }
    }
    liveByParent.set(name, live);
  }

  for (const row of readUnadoptedProjects(dbPath)) {
    const parentProject = row.project.slice(0, row.project.indexOf('/'));
    const candidate: OrphanCandidate = {
      project: row.project,
      parentProject,
      observations: Number(row.observations ?? 0),
      summaries: Number(row.summaries ?? 0),
      firstSeen: row.firstSeen,
      lastSeen: row.lastSeen,
    };

    if (!parentRepos.has(parentProject)) {
      result.skipped.push({
        project: row.project,
        reason: `parent repo "${parentProject}" not resolvable — pass --repo <path>`,
      });
      continue;
    }

    if (liveByParent.get(parentProject)?.has(row.project)) {
      result.live.push(candidate);
    } else {
      result.orphans.push(candidate);
    }
  }

  logger.debug('SYSTEM', 'Orphan scan complete', {
    orphans: result.orphans.length,
    live: result.live.length,
    skipped: result.skipped.length,
  });
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/services/infrastructure/orphan-adoption.test.ts`
Expected: PASS — 7 pass, 0 fail

- [ ] **Step 5: Verify the upstream diff is only the two exports**

Run: `git diff origin/main -- src/services/infrastructure/WorktreeAdoption.ts | grep '^[+-]' | grep -v '^[+-][+-]'`
Expected: exactly four lines — two `-function …` and two `+export function …`, for `gitCapture` and `resolveMainRepoPath` only. Anything else means the constraint was broken.

Run: `git diff --stat origin/main -- src/`
Expected: `OrphanAdoption.ts` as the only new file; `WorktreeAdoption.ts` with 2 insertions / 2 deletions on top of the pre-existing fork delta.

- [ ] **Step 6: Commit**

```bash
git add src/services/infrastructure/OrphanAdoption.ts src/services/infrastructure/WorktreeAdoption.ts tests/services/infrastructure/orphan-adoption.test.ts
git commit -m "feat(orphans): detect memory rows from deleted worktrees

Liveness requires both an existing directory and no \`prunable\` marker —
git keeps listing an rm -rf'd worktree until \`git worktree prune\` runs.
Parent name maps to a SET of repo roots so a shared basename cannot make a
live worktree look deleted.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Decline store

Remembers `n` answers so the same orphan is not re-asked — but keyed by time, so a **reused** worktree name cannot inherit an old decline.

**Files:**
- Modify: `src/services/infrastructure/OrphanAdoption.ts` (append)
- Test: `tests/services/infrastructure/orphan-adoption.test.ts` (append)

**Interfaces:**
- Consumes: `OrphanCandidate` from Task 1.
- Produces:
  - `function readDeclines(dataDirectory?: string): Map<string, string>` — project → ISO timestamp of the decline
  - `function recordDecline(project: string, dataDirectory?: string): void`
  - `function resetDeclines(dataDirectory?: string): void`
  - `function isSuppressed(candidate: OrphanCandidate, declines: Map<string, string>): boolean`

- [ ] **Step 1: Write the failing test**

Extend the **existing** import block at the top of
`tests/services/infrastructure/orphan-adoption.test.ts` — do not add a second
one — so it reads:

```typescript
import {
  scanOrphans,
  readDeclines, recordDecline, resetDeclines, isSuppressed,
  type OrphanCandidate,
} from '../../../src/services/infrastructure/OrphanAdoption.js';
```

Then append to the same file:

```typescript
describe('decline store', () => {
  const candidate = (project: string, lastSeen: string): OrphanCandidate => ({
    project, parentProject: 'demo', observations: 1, summaries: 0,
    firstSeen: lastSeen, lastSeen,
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
    const dataDir = makeDataDir([]);
    recordDecline('demo/reused-name', dataDir);
    const declines = readDeclines(dataDir);

    expect(isSuppressed(candidate('demo/reused-name', '2099-01-01T00:00:00.000Z'), declines)).toBe(false);
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/services/infrastructure/orphan-adoption.test.ts`
Expected: FAIL — `readDeclines is not a function` (or an import error)

- [ ] **Step 3: Write minimal implementation**

Append to `src/services/infrastructure/OrphanAdoption.ts`:

```typescript
const DECISIONS_BASENAME = 'orphan-decisions.json';

interface DeclineEntry {
  project: string;
  at: string;
}

function decisionsPath(dataDirectory?: string): string {
  return path.join(dataDirectory ?? paths.dataDir(), 'state', DECISIONS_BASENAME);
}

/** project -> ISO timestamp the decline was recorded. */
export function readDeclines(dataDirectory?: string): Map<string, string> {
  const file = decisionsPath(dataDirectory);
  const map = new Map<string, string>();
  try {
    if (!existsSync(file)) return map;
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { declined?: DeclineEntry[] };
    for (const entry of parsed?.declined ?? []) {
      if (entry && typeof entry.project === 'string' && typeof entry.at === 'string') {
        map.set(entry.project, entry.at);
      }
    }
  } catch (error: unknown) {
    // Fail open: a corrupt file must re-ask, never silently hide an orphan.
    logger.debug('SYSTEM', 'Orphan decisions unreadable, treating as empty', {
      file,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
  return map;
}

function writeDeclines(entries: Map<string, string>, dataDirectory?: string): void {
  const file = decisionsPath(dataDirectory);
  mkdirSync(path.dirname(file), { recursive: true });
  const payload = {
    declined: [...entries].map(([project, at]) => ({ project, at })),
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8');
}

export function recordDecline(project: string, dataDirectory?: string): void {
  const entries = readDeclines(dataDirectory);
  entries.set(project, new Date().toISOString());
  writeDeclines(entries, dataDirectory);
}

export function resetDeclines(dataDirectory?: string): void {
  writeDeclines(new Map(), dataDirectory);
}

/**
 * A decline holds only until the project gains rows newer than it. That keeps
 * a reused worktree name from inheriting an old `n`, and makes rows written
 * after an adopt (compression lag) surface again rather than vanish.
 */
export function isSuppressed(candidate: OrphanCandidate, declines: Map<string, string>): boolean {
  const declinedAt = declines.get(candidate.project);
  if (!declinedAt) return false;
  return candidate.lastSeen <= declinedAt;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/services/infrastructure/orphan-adoption.test.ts`
Expected: PASS — 0 fail, and the 5 new `decline store` cases all present in the output. (Do not assert an absolute total: earlier tasks' review loops add cases, so a hardcoded count goes stale. Verify no failures and that your own cases ran.)

- [ ] **Step 5: Commit**

```bash
git add src/services/infrastructure/OrphanAdoption.ts tests/services/infrastructure/orphan-adoption.test.ts
git commit -m "feat(orphans): remember declines, keyed by timestamp

A decline suppresses the prompt only while the project has no rows newer
than it, so a reused worktree name cannot inherit an old 'n'. Corrupt file
fails open.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: The adopt operation

The SQLite write. Mirrors `WorktreeAdoption.ts:237-252` exactly, including the Chroma queue flag.

**Files:**
- Modify: `src/services/infrastructure/OrphanAdoption.ts` (append)
- Test: `tests/services/infrastructure/orphan-adoption.test.ts` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `function adoptOrphan(project: string, parentProject: string, opts?: { dataDirectory?: string }): { observations: number; summaries: number }`

- [ ] **Step 1: Write the failing test**

Add `adoptOrphan` to the existing import block at the top of the file, then
append:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/services/infrastructure/orphan-adoption.test.ts`
Expected: FAIL — `adoptOrphan is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `src/services/infrastructure/OrphanAdoption.ts`:

```typescript
/**
 * Adopt one orphaned project into its parent.
 *
 * Mirrors WorktreeAdoption.ts:237-252: set the merge pointer and reset
 * `chroma_merge_synced_at` to NULL, which enqueues the row for the worker's
 * ChromaMergeDrain. This process must NOT open a Chroma writer of its own —
 * the worker holds the single-writer lock (FORK_NOTES.md:313-338).
 *
 * `AND merged_into_project IS NULL` makes it idempotent.
 */
export function adoptOrphan(
  project: string,
  parentProject: string,
  opts: { dataDirectory?: string } = {}
): { observations: number; summaries: number } {
  const dataDirectory = opts.dataDirectory ?? paths.dataDir();
  const dbPath = path.join(dataDirectory, 'claude-mem.db');
  const db = openConfiguredSqliteDatabase(dbPath);
  try {
    const obsColumns = db.prepare('PRAGMA table_info(observations)').all() as Array<{ name: string }>;
    if (!obsColumns.some(c => c.name === 'merged_into_project')) {
      throw new Error('observations.merged_into_project is missing — run the worker once to migrate');
    }

    let observations = 0;
    let summaries = 0;
    const tx = db.transaction(() => {
      observations = db.prepare(
        `UPDATE observations SET merged_into_project = ?, chroma_merge_synced_at = NULL
         WHERE project = ? AND merged_into_project IS NULL`
      ).run(parentProject, project).changes;
      summaries = db.prepare(
        `UPDATE session_summaries SET merged_into_project = ?, chroma_merge_synced_at = NULL
         WHERE project = ? AND merged_into_project IS NULL`
      ).run(parentProject, project).changes;
    });
    tx();

    logger.debug('SYSTEM', 'Adopted orphaned worktree project', {
      project, parentProject, observations, summaries,
    });
    return { observations, summaries };
  } finally {
    db.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/services/infrastructure/orphan-adoption.test.ts`
Expected: PASS — 0 fail, and the 3 new `adoptOrphan` cases all present in the output. (Do not assert an absolute total; earlier tasks' review loops add cases.)

- [ ] **Step 5: Commit**

```bash
git add src/services/infrastructure/OrphanAdoption.ts tests/services/infrastructure/orphan-adoption.test.ts
git commit -m "feat(orphans): adopt an orphaned project into its parent

Sets merged_into_project and nulls chroma_merge_synced_at so the worker's
drain patches Chroma. Never opens a Chroma writer here.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: CLI layer

TTY prompting, formatting, flags. Delegates every decision to Tasks 1-3.

**Files:**
- Create: `scripts/adopt-orphans.ts`
- Modify: `scripts/adopt-mem`

**Interfaces:**
- Consumes: `scanOrphans`, `readDeclines`, `recordDecline`, `resetDeclines`, `isSuppressed`, `adoptOrphan`, `OrphanCandidate` — all from `src/services/infrastructure/OrphanAdoption.js`.
- Produces: the `adopt-mem --orphans` command surface.

- [ ] **Step 1: Write the script**

Create `scripts/adopt-orphans.ts`:

```typescript
#!/usr/bin/env bun
// FORK-OWNED CLI: review and adopt memory rows from deleted worktrees.
//
// Runs from the dev checkout and imports src/ directly, whereas `adopt-mem`
// otherwise execs the INSTALLED plugin-cache build. The two are different
// slices of the code; this command only depends on the merged_into_project /
// chroma_merge_synced_at columns, and adoptOrphan checks for them explicitly
// rather than crashing on a schema mismatch.
import {
  scanOrphans, readDeclines, recordDecline, resetDeclines, isSuppressed, adoptOrphan,
  type OrphanCandidate,
} from '../src/services/infrastructure/OrphanAdoption.js';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const doReset = argv.includes('--reset-declined');
const repoIndex = argv.indexOf('--repo');
const repoPath = repoIndex !== -1 ? argv[repoIndex + 1] : undefined;

if (repoIndex !== -1 && (!repoPath || repoPath.startsWith('--'))) {
  console.error('Usage: adopt-mem --orphans [--dry-run] [--reset-declined] [--repo <path>]');
  process.exit(1);
}

if (doReset) {
  resetDeclines();
  console.log('Cleared all recorded declines.');
}

const total = (c: OrphanCandidate) => c.observations + c.summaries;
const day = (iso: string) => iso.slice(0, 10);
const line = (c: OrphanCandidate) =>
  `  ${c.project.padEnd(38)} ${String(total(c)).padStart(5)} rows   ${day(c.firstSeen)} – ${day(c.lastSeen)}`;

const result = scanOrphans({ repoPath });
const declines = readDeclines();
const pending = result.orphans.filter(c => !isSuppressed(c, declines));

for (const name of result.ambiguousParents) {
  console.log(`! several repos resolve to "${name}" — a worktree is only called orphaned when absent from all of them`);
}
for (const skip of result.skipped) {
  console.log(`! skipped ${skip.project}: ${skip.reason}`);
}

if (pending.length === 0) {
  console.log('\nNo orphaned worktrees awaiting a decision.');
} else {
  console.log(`\nOrphaned worktrees (directory deleted) — ${pending.length}`);
  for (const c of pending) console.log(line(c));
}

if (result.live.length > 0) {
  console.log('\nLive worktrees holding unadopted memory (not touched):');
  for (const c of result.live) {
    console.log(`${line(c)}   run adopt-mem <path> when you are done`);
  }
}

const interactive = Boolean(process.stdin.isTTY) && !dryRun;
if (!interactive || pending.length === 0) {
  if (pending.length > 0) console.log('\n(no TTY or --dry-run: nothing was changed)');
  process.exit(0);
}

function ask(question: string): Promise<string> {
  process.stdout.write(question);
  return new Promise(resolve => {
    process.stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      process.stdin.pause();
      process.stdin.off('data', onData);
      resolve(chunk.trim().toLowerCase());
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

let adoptedObs = 0;
let adoptedSums = 0;
let adoptAll = false;

for (const c of pending) {
  let answer = 'y';
  if (!adoptAll) {
    answer = await ask(`\nAdopt ${c.project} into ${c.parentProject}? [y/n/a/q] `);
  }
  if (answer === 'q') break;
  if (answer === 'a') adoptAll = true;
  if (answer === 'n') {
    recordDecline(c.project);
    console.log(`  declined — not asked again until ${c.project} gains newer rows`);
    continue;
  }
  if (answer !== 'y' && answer !== 'a') {
    console.log('  skipped (no answer recorded)');
    continue;
  }
  const changed = adoptOrphan(c.project, c.parentProject);
  adoptedObs += changed.observations;
  adoptedSums += changed.summaries;
  console.log(`  adopted ${changed.observations} observations + ${changed.summaries} summaries into ${c.parentProject}`);
}

if (adoptedObs + adoptedSums > 0) {
  console.log(`\nAdopted ${adoptedObs + adoptedSums} rows total.`);
  console.log('Chroma is patched by the worker on its next drain (up to an hour) — semantic search lags until then.');
}
process.exit(0);
```

- [ ] **Step 2: Wire it into `adopt-mem`**

In `scripts/adopt-mem`, immediately after the `set -euo pipefail` line, insert:

```bash
# --orphans is a different job from the adoption below: it reviews memory left
# behind by worktrees that no longer exist, which the worktree-list-driven
# adoption can never see. It runs from the dev checkout (it imports src/).
if [[ "${1:-}" == "--orphans" ]]; then
  shift
  exec bun "$HOME/Development/tools/claude-mem/scripts/adopt-orphans.ts" "$@"
fi
```

Then update the usage comment block at the top of the file, adding this line after the `--dry-run` line:

```bash
#   adopt-mem --orphans       review worktrees that were DELETED without being
#                             adopted, and adopt them after approval
```

- [ ] **Step 3: Verify the non-interactive path**

Run: `bun scripts/adopt-orphans.ts --dry-run`
Expected: prints the orphan list (8 projects on this machine, `kedo/dropdown-primevue` and `kedo/frontend-toolchain-host` among them), the live section, then `(no TTY or --dry-run: nothing was changed)`. Exit code 0.

Confirm nothing was written:

Run: `sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM observations WHERE project='kedo/dropdown-primevue' AND merged_into_project IS NULL;"`
Expected: `173` — unchanged.

- [ ] **Step 4: Verify the wiring**

Run: `bash scripts/adopt-mem --orphans --dry-run`
Expected: identical output to Step 3.

- [ ] **Step 5: Commit**

```bash
git add scripts/adopt-orphans.ts scripts/adopt-mem
git commit -m "feat(orphans): adopt-mem --orphans review CLI

Lists orphaned worktree projects for approval (y/n/a/q), plus a read-only
section for live worktrees holding unadopted memory. Non-TTY and --dry-run
never write.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Document in FORK_NOTES

**Files:**
- Modify: `FORK_NOTES.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing — documentation only.

- [ ] **Step 1: Add the entry**

In `FORK_NOTES.md`, in the "Local fixes carried by the fork" list, insert immediately after the `KnownCwdRegistry` bullet (the one ending `Dead paths (removed worktrees) are pruned on write.` and its historical note):

```markdown
- `adopt-mem --orphans` reviews memory left by DELETED worktrees
  (`src/services/infrastructure/OrphanAdoption.ts` + `scripts/adopt-orphans.ts`,
  both fork-owned). Every adoption path enumerates `git worktree list`
  (`WorktreeAdoption.ts:179`), so a worktree that no longer exists can never be
  adopted and its rows keep `merged_into_project IS NULL` forever. Measured
  2026-07-20: 8 projects, 3886 rows invisible to `kedo`-scoped queries. Root
  cause was an orca archive hook that was never wired (`automations: []`), so
  `scripts/adopt-mem` never ran on deletion — the CLI is the cleanup path and
  the backstop for deletions that bypass the hook (`git worktree remove` by
  hand).
  It does NOT decide whether a branch merged: adoption on deletion is
  unconditional by design (`--branch` skips the merged-check entirely,
  `WorktreeAdoption.ts:188-190`), so the tool shows facts and a human approves.
  Two traps worth keeping. First: a worktree deleted with `rm -rf` stays in
  `git worktree list` (flagged `prunable`) until `git worktree prune`, so
  presence in that listing does not mean live — liveness is decided by
  `existsSync` on the directory. The `prunable` term in the code is defense in
  depth only: mutation testing 2026-07-21 showed an implementation ignoring it
  entirely still passes every test, because git sets the flag exactly when the
  gitdir target is missing. Do not document it as load-bearing. Second: the
  parent project name is a repo basename, so it maps to a SET of repo roots —
  two clones collide, and picking one arbitrarily would report the other's live
  worktrees as deleted. Declines live in `~/.claude-mem/state/orphan-decisions.json`
  with a timestamp — they lapse once the project gains newer rows, so a reused
  worktree name cannot inherit an old `n`.
```

- [ ] **Step 2: Add the test file to the upgrade checklist**

In the "Upgrade checklist" section, in the `bun test` command on the fork-focused tests line, the path `tests/services/infrastructure/` already covers the new test file. Confirm by running:

Run: `bun test tests/services/infrastructure/`
Expected: PASS, and the output includes `orphan-adoption.test.ts`.

- [ ] **Step 3: Commit**

```bash
git add FORK_NOTES.md
git commit -m "docs(fork): record the orphan adoption CLI and its two traps

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Run the full fork-focused test suite (sandbox disabled):

```bash
bun test tests/services/infrastructure/ tests/services/sqlite/observations-by-file-merged-scoping.test.ts tests/services/sync/chroma-merge-drain.test.ts
```

Expected: all pass.

- [ ] Run: `bun run typecheck` — expected: clean.

- [ ] Run: `git diff --stat origin/main -- src/ scripts/` — expected: the only new files are `src/services/infrastructure/OrphanAdoption.ts` and `scripts/adopt-orphans.ts`; `scripts/adopt-mem` gains the `--orphans` branch. No upstream file gained a new delta.

- [ ] Run `bash scripts/adopt-mem --orphans` interactively and adopt `kedo/dropdown-primevue` and `kedo/frontend-toolchain-host` (202 + 26 rows). Verify:

```bash
sqlite3 ~/.claude-mem/claude-mem.db "SELECT project, merged_into_project, COUNT(*) FROM observations WHERE project IN ('kedo/dropdown-primevue','kedo/frontend-toolchain-host') GROUP BY 1,2;"
```

Expected: both show `merged_into_project = kedo`.
