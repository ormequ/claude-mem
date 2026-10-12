// fork: observations, session summaries (S####) and user prompts (P####) are
// three independent autoincrement ranges that fully overlap — session ids top
// out well inside the observation range. A caller that drops the display prefix
// therefore gets a real, well-formed, same-project row from the wrong table
// instead of an error: a wrong answer that looks right. Batch fetchers run
// their ids through here so a foreign namespace is rejected loudly.

export type IdNamespace = 'observation' | 'prompt';

const OWN_PREFIX: Record<IdNamespace, string> = { observation: '', prompt: 'P' };

const FOREIGN: Record<string, string> = {
  S: 'a session id (S####). Sessions are not fetchable by id — use timeline({ anchor: "S123" }) or the mem-search skill',
  P: 'a prompt id (P####) — use get_prompts([123])',
};

export function normalizeMemoryIds(ids: Array<number | string>, ns: IdNamespace): number[] {
  return ids.map(raw => {
    if (typeof raw === 'number') {
      if (!Number.isInteger(raw) || raw <= 0) throw new Error(`Invalid ${ns} id: ${raw}`);
      return raw;
    }

    const match = /^#?([A-Za-z]*)(\d+)$/.exec(String(raw).trim());
    if (!match) throw new Error(`Invalid ${ns} id: "${raw}"`);

    const prefix = match[1].toUpperCase();
    if (prefix !== '' && prefix !== OWN_PREFIX[ns]) {
      const what = FOREIGN[prefix] ?? `prefixed "${prefix}", which is not a ${ns} id`;
      throw new Error(`"${raw}" is ${what}.`);
    }

    return parseInt(match[2], 10);
  });
}
