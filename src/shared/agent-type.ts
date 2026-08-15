// Fork-owned. Canonicalizes `agent_type` at the ingest boundary so one spelling of a role is
// one value. Sits beside `platform-source.ts`, which does the same job for the same call
// site; keeping it a fork-owned module leaves upstream's `http/shared.ts` a one-line delta.
// See FORK_NOTES.
//
// Scope, stated honestly because the measurement is unflattering: this merges 530 of 10,082
// tagged rows (`Explore` → `explore`) and takes the distinct count from 467 to 466. It does
// NOT make `agent_type` a role dimension — the remaining 464 values are per-task agent
// instance names (`impl-mk-cluster-os`, `evidence-switch-auth`, …), not roles, which is
// DEC-18's finding. Filtering by role needs a separate field or a mapping; canonicalizing
// spelling is worth its one line, and is not that feature.

export function normalizeAgentType(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') return undefined;

  const canonical = value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');

  return canonical || undefined;
}
