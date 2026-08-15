import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { isMachineRelayPrompt, notMachineRelaySql } from '../src/shared/user-prompts.js';

const RELAY = '<agent-message from="impl-task1">\n**Status:** DONE';
const CROSS = '<cross-session-message from="other">hi</cross-session-message>';
const HUMAN = 'чекни ledger — давай поправим тут agent-message';

test('isMachineRelayPrompt matches envelopes, not human text mentioning them', () => {
  expect(isMachineRelayPrompt(RELAY)).toBe(true);
  expect(isMachineRelayPrompt(CROSS)).toBe(true);
  expect(isMachineRelayPrompt(HUMAN)).toBe(false);
});

test('notMachineRelaySql filters the same rows the TS predicate does', () => {
  const db = new Database(':memory:');
  db.run('CREATE TABLE up (prompt_text TEXT)');
  const insert = db.prepare('INSERT INTO up (prompt_text) VALUES (?)');
  for (const text of [RELAY, CROSS, HUMAN]) insert.run(text);

  const kept = db
    .query(`SELECT prompt_text FROM up WHERE ${notMachineRelaySql('up')}`)
    .all() as Array<{ prompt_text: string }>;

  expect(kept.map(r => r.prompt_text)).toEqual(
    [RELAY, CROSS, HUMAN].filter(t => !isMachineRelayPrompt(t))
  );
});
