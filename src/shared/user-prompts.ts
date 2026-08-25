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
];

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
