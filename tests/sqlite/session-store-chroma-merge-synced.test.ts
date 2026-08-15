import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

const MERGE_TABLES = ['observations', 'session_summaries'] as const;

// Index names follow the existing convention: observations → idx_observations_*,
// session_summaries → idx_summaries_* (see ensureMergedIntoProjectColumns).
const MERGE_UNSYNCED_INDEX: Record<string, string> = {
  observations: 'idx_observations_merge_unsynced',
  session_summaries: 'idx_summaries_merge_unsynced',
};

function columnNames(db: Database, table: string): Set<string> {
  return new Set(
    (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(col => col.name)
  );
}

describe('SessionStore chroma_merge_synced_at migration', () => {
  let tempDir: string;
  let missingStatePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-merge-synced-'));
    missingStatePath = join(tempDir, 'does-not-exist.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('adds chroma_merge_synced_at column to observations and session_summaries', () => {
    const db = new Database(':memory:');
    try {
      new SessionStore(db, { cloudSyncStatePath: missingStatePath });
      for (const table of MERGE_TABLES) {
        expect(columnNames(db, table).has('chroma_merge_synced_at')).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it('creates a partial index over merged-but-unpatched rows usable by the drain query', () => {
    const db = new Database(':memory:');
    try {
      new SessionStore(db, { cloudSyncStatePath: missingStatePath });
      for (const table of MERGE_TABLES) {
        const index = db.prepare(`
          SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?
        `).get(MERGE_UNSYNCED_INDEX[table]) as { sql: string } | undefined;
        expect(index?.sql).toContain('merged_into_project IS NOT NULL');
        expect(index?.sql).toContain('chroma_merge_synced_at IS NULL');
      }

      // The drain query must be index-backed (not a full table scan). Without
      // ANALYZE stats the planner may prefer idx_observations_merged_into over
      // the partial index; both avoid a full scan, which is the guarantee we
      // care about. The partial index still wins once stats know most merged
      // rows are already patched.
      const plan = db.prepare(
        `EXPLAIN QUERY PLAN SELECT id FROM observations
           WHERE merged_into_project IS NOT NULL AND chroma_merge_synced_at IS NULL`
      ).all() as Array<{ detail: string }>;
      expect(plan.some(row => row.detail.includes('USING INDEX') || row.detail.includes('USING COVERING INDEX'))).toBe(true);
      expect(plan.some(row => /\bSCAN observations\b(?!.*USING)/.test(row.detail))).toBe(false);
    } finally {
      db.close();
    }
  });

  it('is idempotent: repeat construction does not throw or duplicate the column', () => {
    const db = new Database(':memory:');
    try {
      new SessionStore(db, { cloudSyncStatePath: missingStatePath });
      expect(() => new SessionStore(db, { cloudSyncStatePath: missingStatePath })).not.toThrow();

      for (const table of MERGE_TABLES) {
        const cols = (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
          .filter(col => col.name === 'chroma_merge_synced_at');
        expect(cols.length).toBe(1);
      }
    } finally {
      db.close();
    }
  });
});
