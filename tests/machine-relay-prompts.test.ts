import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { isMachineRelayPrompt, notMachineRelaySql } from '../src/shared/user-prompts.js';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';

const RELAY = '<agent-message from="impl-task1">\n**Status:** DONE';
const CROSS = '<cross-session-message from="other">hi</cross-session-message>';
const HUMAN = 'чекни ledger — давай поправим тут agent-message';
// Envelope-less injections: one orchestrator repeated these through a whole session and
// every one of them counted as something the user typed.
const ORCA_CHECK = 'You have 2 orchestration messages. Run `orca orchestration check --run run_1234`.';
const ORCA_WORKER = 'You are working inside Orca, a multi-agent IDE. You are a dispatched worker.\nYour task ID is: task_1';
// The same injection appended to what the user actually wrote — the user's words are the row.
const MIXED = 'я дропнул старого воркера.\nYou have 2 orchestration messages.';

// Outbound briefs: typed into another agent's session, so they carry a marker, not an envelope.
const AGENT_BRIEF = '[agent] Machine-written messages land in the `user_prompts` table.';
const CODEX_BRIEF = 'IMPORTANT: Do NOT read or execute any files under ~/.claude/, ~/.agents/, .claude/skills/, or agents/.\n\nReview the plan.';
const HUMAN_AGENT = 'почему [agent] сообщения попадают в промпты?';
// A marked brief pasted whole by hand, versus the same paste followed by the user's own words.
const PASTED_BRIEF = '<pasted_content id="91ea">\n[agent] From the other session: done.\n</pasted_content id="91ea">';
const PASTED_THEN_HUMAN = PASTED_BRIEF + '\nа это мой вопрос';
const ORCA_REDISPATCH = 'Please carry out this task from my Orca coordinator by following the brief I pasted below. \n\n<pasted_content id="5e78">\nYou are working inside Orca';

const ALL = [RELAY, CROSS, HUMAN, ORCA_CHECK, ORCA_WORKER, MIXED, AGENT_BRIEF, CODEX_BRIEF, HUMAN_AGENT,
  PASTED_BRIEF, PASTED_THEN_HUMAN, ORCA_REDISPATCH];

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

test('isMachineRelayPrompt matches outbound agent briefs by their head marker only', () => {
  expect(isMachineRelayPrompt(AGENT_BRIEF)).toBe(true);
  expect(isMachineRelayPrompt(CODEX_BRIEF)).toBe(true);
  expect(isMachineRelayPrompt(HUMAN_AGENT)).toBe(false);
});

test('isMachineRelayPrompt matches a marked brief pasted whole and an Orca re-dispatch', () => {
  expect(isMachineRelayPrompt(PASTED_BRIEF)).toBe(true);
  expect(isMachineRelayPrompt(PASTED_THEN_HUMAN)).toBe(false);
  expect(isMachineRelayPrompt(ORCA_REDISPATCH)).toBe(true);
});

test('human_user_prompts view keeps exactly the rows the predicate keeps, and survives reopen', () => {
  const store = new SessionStore(':memory:');
  const db = store.db;
  const sessionId = db.query(
    "INSERT INTO sdk_sessions (content_session_id, project, started_at, started_at_epoch) VALUES ('s1', 'p', 'x', 0) RETURNING id"
  ).get() as { id: number };
  const insert = db.prepare(
    "INSERT INTO user_prompts (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch) VALUES (?, 's1', ?, ?, 'x', 0)"
  );
  ALL.forEach((text, i) => insert.run(sessionId.id, i + 1, text));

  const before = db.query("SELECT sql FROM sqlite_master WHERE name = 'human_user_prompts'").get();
  new SessionStore(db);
  expect(db.query("SELECT sql FROM sqlite_master WHERE name = 'human_user_prompts'").get()).toEqual(before);

  const kept = db.query('SELECT prompt_text FROM human_user_prompts ORDER BY prompt_number').all() as Array<{ prompt_text: string }>;
  expect(kept.map(r => r.prompt_text)).toEqual(ALL.filter(t => !isMachineRelayPrompt(t)));
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
