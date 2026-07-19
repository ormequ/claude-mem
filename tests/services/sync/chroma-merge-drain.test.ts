import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { drainChromaMergeQueue } from '../../../src/services/sync/ChromaMergeDrain.js';

interface UpdateCall {
  ids: number[];
  project: string;
  docType?: string;
}

/**
 * Minimal ChromaSync stand-in: records updateMergedIntoProject calls and can be
 * told to reject for a given target project (to exercise partial-failure retry).
 */
function fakeChromaSync(failForProject?: string) {
  const calls: UpdateCall[] = [];
  return {
    calls,
    async updateMergedIntoProject(ids: number[], project: string, docType?: string) {
      calls.push({ ids: [...ids], project, docType });
      if (failForProject && project === failForProject) {
        throw new Error(`chroma boom for ${project}`);
      }
    },
  };
}

function seed(db: Database): void {
  const now = new Date().toISOString();
  const epoch = Date.now();
  db.prepare(`
    INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES ('c1', 'm1', 'wt-proj', ?, ?, 'active')
  `).run(now, epoch);
}

function insertObs(db: Database, hash: string, opts: { merged?: string | null; flag?: number | null }): number {
  const now = new Date().toISOString();
  const epoch = Date.now();
  const info = db.prepare(`
    INSERT INTO observations (memory_session_id, project, type, content_hash, merged_into_project, chroma_merge_synced_at, created_at, created_at_epoch)
    VALUES ('m1', 'wt-proj', 'discovery', ?, ?, ?, ?, ?)
  `).run(hash, opts.merged ?? null, opts.flag ?? null, now, epoch);
  return Number(info.lastInsertRowid);
}

function insertSummary(db: Database, opts: { merged?: string | null; flag?: number | null }): number {
  const now = new Date().toISOString();
  const epoch = Date.now();
  const info = db.prepare(`
    INSERT INTO session_summaries (memory_session_id, project, request, merged_into_project, chroma_merge_synced_at, created_at, created_at_epoch)
    VALUES ('m1', 'wt-proj', 'req', ?, ?, ?, ?)
  `).run(opts.merged ?? null, opts.flag ?? null, now, epoch);
  return Number(info.lastInsertRowid);
}

function flagOf(db: Database, table: string, id: number): number | null {
  return (db.prepare(`SELECT chroma_merge_synced_at AS f FROM ${table} WHERE id = ?`).get(id) as { f: number | null }).f;
}

describe('drainChromaMergeQueue', () => {
  let tempDir: string;
  let db: Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-drain-'));
    db = new Database(':memory:');
    new SessionStore(db, { cloudSyncStatePath: join(tempDir, 'nope.json') });
    seed(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('patches dirty observation and summary rows and stamps them on success', async () => {
    const o1 = insertObs(db, 'o1', { merged: 'kedo' });
    const o2 = insertObs(db, 'o2', { merged: 'kedo' });
    const s1 = insertSummary(db, { merged: 'kedo' });

    const chroma = fakeChromaSync();
    const result = await drainChromaMergeQueue(db, chroma as any);

    expect(result.patched).toBe(3);
    expect(result.failedGroups).toBe(0);

    // observation group and summary group each carry the right doc_type
    const obsCall = chroma.calls.find(c => c.docType === 'observation');
    const sumCall = chroma.calls.find(c => c.docType === 'session_summary');
    expect(obsCall?.project).toBe('kedo');
    expect(new Set(obsCall?.ids)).toEqual(new Set([o1, o2]));
    expect(sumCall?.ids).toEqual([s1]);

    expect(flagOf(db, 'observations', o1)).not.toBeNull();
    expect(flagOf(db, 'observations', o2)).not.toBeNull();
    expect(flagOf(db, 'session_summaries', s1)).not.toBeNull();
  });

  it('groups by merged_into_project', async () => {
    const a = insertObs(db, 'a', { merged: 'kedo' });
    const b = insertObs(db, 'b', { merged: 'other' });

    const chroma = fakeChromaSync();
    await drainChromaMergeQueue(db, chroma as any);

    const obsCalls = chroma.calls.filter(c => c.docType === 'observation');
    const byProject = new Map(obsCalls.map(c => [c.project, c.ids]));
    expect(byProject.get('kedo')).toEqual([a]);
    expect(byProject.get('other')).toEqual([b]);
  });

  it('leaves a failed group NULL for retry while stamping successful ones', async () => {
    const good = insertObs(db, 'good', { merged: 'kedo' });
    const bad = insertObs(db, 'bad', { merged: 'other' });

    const chroma = fakeChromaSync('other');
    const result = await drainChromaMergeQueue(db, chroma as any);

    expect(result.failedGroups).toBe(1);
    expect(flagOf(db, 'observations', good)).not.toBeNull();
    expect(flagOf(db, 'observations', bad)).toBeNull();
  });

  it('is a no-op when the queue is empty', async () => {
    // A row already patched (flag set) and a never-merged row must be ignored.
    insertObs(db, 'patched', { merged: 'kedo', flag: 123 });
    insertObs(db, 'unmerged', { merged: null });

    const chroma = fakeChromaSync();
    const result = await drainChromaMergeQueue(db, chroma as any);

    expect(result.patched).toBe(0);
    expect(chroma.calls.length).toBe(0);
  });

  it('backfills pre-existing merged rows whose flag defaulted to NULL', async () => {
    // Simulates history: rows merged by the old code path, flag column added by
    // migration as NULL — the drain must pick them up.
    const legacy = insertObs(db, 'legacy', { merged: 'kedo', flag: null });

    const chroma = fakeChromaSync();
    await drainChromaMergeQueue(db, chroma as any);

    expect(flagOf(db, 'observations', legacy)).not.toBeNull();
  });
});
