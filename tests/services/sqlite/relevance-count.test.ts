// FORK: relevance_count shipped as a column with no writer — every row sat at
// 0. These pin the contract in src/services/sqlite/observations/relevance.ts:
// a retrieval is "entered a context", and a failed count never fails the read.
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { bumpRelevanceCount } from '../../../src/services/sqlite/observations/relevance.js';

function makeDb(): Database {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    relevance_count INTEGER DEFAULT 0
  )`);
  for (const project of ['a', 'b', 'c']) {
    db.run('INSERT INTO observations (project) VALUES (?)', [project]);
  }
  return db;
}

function countOf(db: Database, id: number): number | null {
  return (db.prepare('SELECT relevance_count FROM observations WHERE id = ?').get(id) as
    { relevance_count: number | null }).relevance_count;
}

describe('bumpRelevanceCount', () => {
  it('adds one retrieval per call to exactly the ids given', () => {
    const db = makeDb();

    expect(bumpRelevanceCount(db, [1, 3])).toBe(2);
    bumpRelevanceCount(db, [1]);

    expect(countOf(db, 1)).toBe(2);
    expect(countOf(db, 2)).toBe(0);
    expect(countOf(db, 3)).toBe(1);
    db.close();
  });

  it('counts up from a legacy NULL instead of staying NULL', () => {
    // The column was added with DEFAULT 0, but rows written before that
    // migration carry NULL — `NULL + 1` is NULL, which would keep them dead.
    const db = makeDb();
    db.run('UPDATE observations SET relevance_count = NULL WHERE id = 2');

    bumpRelevanceCount(db, [2]);

    expect(countOf(db, 2)).toBe(1);
    db.close();
  });

  it('never throws when the write fails — the read it counts must still succeed', () => {
    const db = makeDb();
    db.run('DROP TABLE observations');

    expect(bumpRelevanceCount(db, [1])).toBe(0);
    db.close();
  });

  it('counts through the flag set the injection path opens with', () => {
    // The injection path reads through a READ-ONLY connection and opens a
    // second writable one just for this. bun:sqlite rejects a flag set with
    // neither READONLY nor READWRITE — `{ readonly: false }` IS that empty set
    // and throws at open, which silently killed the counter once already.
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'claude-mem-relevance-')), 'db.sqlite');
    const seed = new Database(file, { create: true });
    seed.run('CREATE TABLE observations (id INTEGER PRIMARY KEY, relevance_count INTEGER DEFAULT 0)');
    seed.run('INSERT INTO observations (id) VALUES (1)');
    seed.close();

    const writable = new Database(file, { readwrite: true, create: false });
    expect(bumpRelevanceCount(writable, [1])).toBe(1);
    expect(countOf(writable, 1)).toBe(1);
    writable.close();
  });

  it('does nothing on an empty id list', () => {
    const db = makeDb();
    expect(bumpRelevanceCount(db, [])).toBe(0);
    expect(countOf(db, 1)).toBe(0);
    db.close();
  });
});
