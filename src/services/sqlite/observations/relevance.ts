// FORK-OWNED: `observations.relevance_count`.
//
// WHAT IT COUNTS: how many times this observation was pulled back OUT of the
// store and put in front of a model. The question it answers is "was writing
// this row worth the generation cost" — a row that is written and never read
// again is pure cost, and the counter is what makes that class of record
// visible. It is NOT a ranking input: nothing reads it at query time, and
// nothing should start to without revisiting this comment.
//
// EXACTLY TWO EVENTS INCREMENT IT, both meaning "entered a context":
//   1. `get_observations` — a deliberate full-text fetch of specific ids
//      (`POST /api/observations/batch`).
//   2. Session-start injection — the rows rendered into the context a session
//      begins with (`ContextBuilder.generateContextWithStats`, which covers
//      both the hook path and the `session_start_context` preview).
//
// WHAT DOES NOT INCREMENT IT, deliberately: search-index listings. `search`
// returns truncated rows, and semantic search hydrates Chroma-matched ids
// through `getObservationsByIds` to render that same listing — so counting
// there would make "matched a query" indistinguishable from "was used", which
// is the distinction the counter exists to draw. That is also why the bump
// lives at the get_observations ROUTE rather than inside the shared store
// method the listing path also calls.
//
// The column is excluded from sync (SyncApply.ts) — it is a device-local usage
// counter, so each device counts its own retrievals and they never merge.
import type { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';

/**
 * Add one retrieval to each of `ids`. Best-effort: a failed count must never
 * fail the read it is counting, so this swallows its errors and reports how
 * many rows it stamped (0 on failure).
 */
export function bumpRelevanceCount(db: Database, ids: number[]): number {
  if (ids.length === 0) return 0;
  try {
    const placeholders = ids.map(() => '?').join(',');
    return db.prepare(
      `UPDATE observations SET relevance_count = COALESCE(relevance_count, 0) + 1 WHERE id IN (${placeholders})`
    ).run(...ids).changes;
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.debug('DB', 'Failed to record observation retrieval', { count: ids.length }, err);
    return 0;
  }
}
