import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { isMachineRelayPrompt, notMachineRelaySql } from '../src/shared/user-prompts.js';

const RELAY = '<agent-message from="impl-task1">\n**Status:** DONE';
const CROSS = '<cross-session-message from="other">hi</cross-session-message>';
const HUMAN = 'чекни ledger — давай поправим тут agent-message';
// Envelope-less injections: one orchestrator repeated these through a whole session and
// every one of them counted as something the user typed.
const ORCA_CHECK = 'You have 2 orchestration messages. Run `orca orchestration check --run run_1234`.';
const ORCA_WORKER = 'You are working inside Orca, a multi-agent IDE. You are a dispatched worker.\nYour task ID is: task_1';
// The same injection appended to what the user actually wrote — the user's words are the row.
const MIXED = 'я дропнул старого воркера.\nYou have 2 orchestration messages.';

const ALL = [RELAY, CROSS, HUMAN, ORCA_CHECK, ORCA_WORKER, MIXED];

test('isMachineRelayPrompt matches envelopes, not human text mentioning them', () => {
  expect(isMachineRelayPrompt(RELAY)).toBe(true);
  expect(isMachineRelayPrompt(CROSS)).toBe(true);
  expect(isMachineRelayPrompt(HUMAN)).toBe(false);
});

test('isMachineRelayPrompt matches envelope-less injections, but not a prompt they were appended to', () => {
  expect(isMachineRelayPrompt(ORCA_CHECK)).toBe(true);
  expect(isMachineRelayPrompt(ORCA_WORKER)).toBe(true);
  expect(isMachineRelayPrompt(MIXED)).toBe(false);
});

test('notMachineRelaySql filters the same rows the TS predicate does', () => {
  const db = new Database(':memory:');
  db.run('CREATE TABLE up (prompt_text TEXT)');
  const insert = db.prepare('INSERT INTO up (prompt_text) VALUES (?)');
  for (const text of ALL) insert.run(text);

  const kept = db
    .query(`SELECT prompt_text FROM up WHERE ${notMachineRelaySql('up')}`)
    .all() as Array<{ prompt_text: string }>;

  expect(kept.map(r => r.prompt_text)).toEqual(
    ALL.filter(t => !isMachineRelayPrompt(t))
  );
});
