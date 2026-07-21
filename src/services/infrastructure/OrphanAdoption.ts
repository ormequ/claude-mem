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
