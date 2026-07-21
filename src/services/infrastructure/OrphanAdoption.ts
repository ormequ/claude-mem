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
import type { Database } from 'bun:sqlite';
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
  /** Same instants as firstSeen/lastSeen, as `created_at_epoch` integers straight from SQLite — never parsed from text. */
  firstSeenEpoch: number;
  lastSeenEpoch: number;
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
 * A worktree deleted with `rm -rf` rather than `git worktree remove` stays in
 * this listing until `git worktree prune` runs, flagged
 * `prunable gitdir file points to non-existent location`.
 *
 * Note on what actually does the work: `existsSync` in `isLive` is what
 * catches that case. Git sets `prunable` exactly when the gitdir target is
 * missing, so a prunable entry whose directory still exists and still
 * resolves to a `parent/child` project name is not constructible today. The
 * `prunable` term is kept as defense in depth against future git behavior,
 * not because any current case depends on it — verified by mutation testing
 * 2026-07-21.
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
  const seeds = repoPath ? [repoPath, ...listKnownCwds(dataDirectory)] : listKnownCwds(dataDirectory);
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
  firstSeenEpoch: number;
  lastSeenEpoch: number;
}

function readUnadoptedProjects(dbPath: string): ProjectRow[] {
  const db = openConfiguredSqliteDatabase(dbPath);
  try {
    return db.prepare(`
      SELECT project,
             SUM(obs) AS observations,
             SUM(sums) AS summaries,
             MIN(first_seen) AS firstSeen,
             MAX(last_seen) AS lastSeen,
             MIN(first_seen_epoch) AS firstSeenEpoch,
             MAX(last_seen_epoch) AS lastSeenEpoch
      FROM (
        SELECT project, COUNT(*) AS obs, 0 AS sums,
               MIN(created_at) AS first_seen, MAX(created_at) AS last_seen,
               MIN(created_at_epoch) AS first_seen_epoch, MAX(created_at_epoch) AS last_seen_epoch
        FROM observations WHERE merged_into_project IS NULL GROUP BY project
        UNION ALL
        SELECT project, 0 AS obs, COUNT(*) AS sums,
               MIN(created_at) AS first_seen, MAX(created_at) AS last_seen,
               MIN(created_at_epoch) AS first_seen_epoch, MAX(created_at_epoch) AS last_seen_epoch
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
      firstSeenEpoch: Number(row.firstSeenEpoch),
      lastSeenEpoch: Number(row.lastSeenEpoch),
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

/**
 * Whether `table` has a column named `column`. Same shape as
 * ChromaMergeDrain.ts's `hasFlagColumn` — kept as a local copy rather than an
 * import, since this module must not depend on the sync module.
 */
function hasColumn(db: Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some(c => c.name === column);
}

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
  const declined = Date.parse(declinedAt);
  // Fail open: an unparseable decline timestamp must re-ask, never suppress.
  // The DB side (lastSeenEpoch) is `created_at_epoch`, a schema-enforced
  // INTEGER (milliseconds since epoch, SessionStore.ts) read straight out of
  // SQLite — it is never parsed from text, so it carries no timezone or
  // format risk. `Date.parse(declinedAt)` is a real string-format parse of a
  // form we control (recordDecline always writes `toISOString()`), which is
  // why only this side needs the NaN guard.
  if (Number.isNaN(declined)) return false;
  return candidate.lastSeenEpoch <= declined;
}

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
    // Both columns this function writes, on both tables — each added by its
    // own ALTER TABLE migration, so any one of the four can be missing on an
    // unmigrated DB. Checking only observations.merged_into_project (as this
    // used to) leaves the other three reachable and unchecked.
    for (const table of ['observations', 'session_summaries'] as const) {
      for (const column of ['merged_into_project', 'chroma_merge_synced_at'] as const) {
        if (!hasColumn(db, table, column)) {
          throw new Error(`${table}.${column} is missing — run the worker once to migrate`);
        }
      }
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
