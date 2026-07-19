// FORK-OWNED: drains the merged-into-project Chroma patch queue.
//
// The CLI `adopt` process can't take Chroma's single-writer lock (the
// long-lived worker holds it), so adoption only marks rows in SQLite —
// merged_into_project set, chroma_merge_synced_at reset to NULL. This drain
// runs INSIDE the worker (startup + each AdoptionScheduler tick), where the
// lock is available, and patches the Chroma document metadata to match.
//
// It reads SQLite state, not git worktrees, so a worktree deleted right after
// `adopt_mem` can no longer strand its rows unpatched. Rows whose flag defaults
// to NULL after the column migration are picked up automatically, which
// backfills history on the first run. See FORK_NOTES.md.
import type { Database } from 'bun:sqlite';
import type { ChromaSync } from './ChromaSync.js';
import { logger } from '../../utils/logger.js';

export interface DrainResult {
  patched: number;
  groups: number;
  failedGroups: number;
}

interface DrainTarget {
  table: 'observations' | 'session_summaries';
  docType: 'observation' | 'session_summary';
}

const TARGETS: DrainTarget[] = [
  { table: 'observations', docType: 'observation' },
  { table: 'session_summaries', docType: 'session_summary' },
];

// Keep Chroma-patch and flag-stamp aligned per chunk so a mid-group failure
// preserves the progress of already-patched chunks (they get stamped and won't
// be retried) while the rest stays NULL for the next tick.
const CHUNK = 100;

function hasFlagColumn(db: Database, table: string): boolean {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some(c => c.name === 'chroma_merge_synced_at');
}

/**
 * Patch every dirty row (merged_into_project set, chroma_merge_synced_at NULL)
 * into Chroma, grouped by target project. Idempotent and resumable: a row is
 * stamped only after its Chroma chunk succeeds.
 */
export async function drainChromaMergeQueue(
  db: Database,
  chromaSync: Pick<ChromaSync, 'updateMergedIntoProject'>
): Promise<DrainResult> {
  let patched = 0;
  let groups = 0;
  let failedGroups = 0;

  for (const { table, docType } of TARGETS) {
    if (!hasFlagColumn(db, table)) continue;

    const rows = db.prepare(
      `SELECT id, merged_into_project AS project FROM ${table}
        WHERE merged_into_project IS NOT NULL AND chroma_merge_synced_at IS NULL
        ORDER BY id`
    ).all() as Array<{ id: number; project: string }>;
    if (rows.length === 0) continue;

    const byProject = new Map<string, number[]>();
    for (const row of rows) {
      const bucket = byProject.get(row.project);
      if (bucket) bucket.push(row.id);
      else byProject.set(row.project, [row.id]);
    }

    const stamp = db.prepare(`UPDATE ${table} SET chroma_merge_synced_at = ? WHERE id = ?`);

    for (const [project, ids] of byProject) {
      groups++;
      try {
        for (let i = 0; i < ids.length; i += CHUNK) {
          const chunk = ids.slice(i, i + CHUNK);
          await chromaSync.updateMergedIntoProject(chunk, project, docType);
          const now = Date.now();
          const stampChunk = db.transaction((c: number[]) => {
            for (const id of c) stamp.run(now, id);
          });
          stampChunk(chunk);
          patched += chunk.length;
        }
      } catch (err) {
        failedGroups++;
        logger.warn(
          'CHROMA_SYNC',
          'merge drain group failed (rows stay queued for next tick)',
          { table, project, groupSize: ids.length },
          err instanceof Error ? err : new Error(String(err))
        );
      }
    }
  }

  if (patched > 0 || failedGroups > 0) {
    logger.info('CHROMA_SYNC', 'merge drain pass complete', { patched, groups, failedGroups });
  }

  return { patched, groups, failedGroups };
}
