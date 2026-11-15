export const USER_PROMPT_DEDUPE_WINDOW_MS = 10_000;

/**
 * Machine relays — a delegate's report (`<agent-message from=...>`), a cross-session
 * message, or an orchestrator's injection — arrive on the same hook as human text and are
 * stored verbatim. The row is kept (it is a real record of what a delegate reported), so
 * consumers that mean "what the user typed" filter on read. The prompt text is the marker;
 * no extra column is stored for it.
 *
 * Patterns are SQL LIKE patterns so one list drives both the SQL and the TS form. An
 * envelope is the reliable marker; the literal-text entries exist because an injector that
 * ships no envelope is otherwise indistinguishable from the user. Each matches only a
 * prompt that is nothing but the injection — a human prompt with an injection appended
 * still starts with the human's words and stays.
 *
 * A relay a human pasted between terminals by hand carries no marker at all and cannot be
 * caught here; that one needs the relaying agent to wrap it.
 */
const MACHINE_RELAY_PATTERNS = [
  '<agent-message%',
  '<cross-session-message%',
  'You have % orchestration message%',
  'You are working inside Orca, a multi-agent IDE.%',
  // The marker an agent writes at the head of a brief it types into another agent's session —
  // the outbound shape, which otherwise arrives as plain text. LIKE treats `[` literally.
  '[agent]%',
  // The same brief pasted whole into a session by hand: Claude Code wraps the paste, so the
  // marker sits right after the opening tag. Both tags are anchored, so a paste followed by the
  // human's own words does not match.
  '<pasted_content id="____">_[agent]%</pasted_content id="____">',
  // The preamble gstack's codex skill puts on every brief it hands codex.
  'IMPORTANT: Do NOT read or execute any files under ~/.claude/%',
  // Orca's re-dispatch of a task to a worker session.
  'Please carry out this task from my Orca coordinator by following the brief I pasted below.%',
];

/** user_prompts minus machine relays, as a view, for readers that query SQLite directly. */
export const HUMAN_USER_PROMPTS_VIEW = 'human_user_prompts';

function likeToRegExp(pattern: string): RegExp {
  const body = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/%/g, '[\\s\\S]*')
    .replace(/_/g, '[\\s\\S]');
  return new RegExp(`^${body}$`);
}

const MACHINE_RELAY_REGEXPS = MACHINE_RELAY_PATTERNS.map(likeToRegExp);

export function isMachineRelayPrompt(promptText: string): boolean {
  const head = promptText.trimStart();
  return MACHINE_RELAY_REGEXPS.some(re => re.test(head));
}

/** SQL form of isMachineRelayPrompt, for WHERE clauses. */
export function notMachineRelaySql(table = 'up'): string {
  return MACHINE_RELAY_PATTERNS
    .map(pattern => `${table}.prompt_text NOT LIKE '${pattern}'`)
    .join(' AND ');
}
