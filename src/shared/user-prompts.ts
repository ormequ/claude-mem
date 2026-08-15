export const USER_PROMPT_DEDUPE_WINDOW_MS = 10_000;

/**
 * Machine relays — a delegate's report (`<agent-message from=...>`) or a
 * cross-session message — arrive on the same hook as human text and are stored
 * verbatim. The row is kept (it is a real record of what a delegate reported),
 * so consumers that mean "what the user typed" filter on read. The envelope in
 * prompt_text is the marker; no extra column is stored for it.
 */
const MACHINE_RELAY_PREFIXES = ['<agent-message', '<cross-session-message'];

export function isMachineRelayPrompt(promptText: string): boolean {
  const head = promptText.trimStart();
  return MACHINE_RELAY_PREFIXES.some(prefix => head.startsWith(prefix));
}

/** SQL form of isMachineRelayPrompt, for WHERE clauses. */
export function notMachineRelaySql(table = 'up'): string {
  return MACHINE_RELAY_PREFIXES
    .map(prefix => `${table}.prompt_text NOT LIKE '${prefix}%'`)
    .join(' AND ');
}
