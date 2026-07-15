# Observer Concepts Discipline: Write-Time Whitelist + Ranking Replay Harness

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the observation `concepts` vocabulary trustworthy: enforce the mode's declared enum at parse time (the model ignores prompt-level MUST at scale — 50% of stored concept values are off-vocabulary, 28,404/56,954 measured 2026-07-15), and commit the ranking replay harness that gates any future read-hook ranking change.

**Architecture:** A pure `filterConcepts` helper in `src/sdk/parser.ts` (the existing concept-cleaning spot, next to the type-leak filter at ~line 119) with a drop-stats JSONL sink; the allowed list comes from the active mode's `observation_concepts`. The replay harness is a standalone bun script in `scripts/`, no runtime coupling.

**Context (verified, do not re-litigate):**
- Z.AI coding endpoint (`api.z.ai/api/coding/paas/v4`) silently ignores `response_format: json_schema` — constrained decoding is NOT available; write-time filtering is the only reliable enforcement (probe 2026-07-15).
- Prompt wording is already obeyed in small contexts (4 variants × 5 notes: all 5/5 enum-clean, including the current prompt) — the 50% violation rate is a long-context attention effect, so prompt tweaks alone cannot fix it.
- `plugin/modes/code.json` was already updated (commit alongside this plan): 0-2 sparse concepts, anti-topic block, new `deliberate-decision` concept, enum reminder in footer.
- Vocabulary governance: a new concept id is added ONLY with (a) a concrete consumer reading it and (b) drop-stats evidence of demand. Do not add values speculatively.

## Global Constraints

- The whitelist must be mode-aware: `law-study` declares a different `observation_concepts` vocabulary; hardcoding the code-mode list as the only truth would destroy law-mode concepts. Fallback to the ACTIVE mode's ids; only if no mode is resolvable, fall back to code-mode's 8.
- Never drop the whole observation because its concepts were filtered to empty — the existing "skip empty observation" check must keep treating title/facts/narrative as content.
- Run per task: `bun run typecheck` + the task's test file. Commit per task.
- After deploy (`npm run build-and-sync`): verify the installed bundle contains the change (grep the marketplace `worker-service.cjs` for a marker; cache shadowing has silently reverted deploys before).

---

### Task 1: Concepts whitelist + drop-stats at parse time

**Files:**
- Modify: `src/sdk/parser.ts` (concept cleaning block, ~lines 119–128)
- Test: `tests/sdk/parser-concepts-whitelist.test.ts` (new)

**Interfaces:**
- Produces: `filterConcepts(concepts: string[], allowed: ReadonlySet<string>): { kept: string[]; dropped: string[] }` (exported for tests). `parseAgentXml`'s signature is UNCHANGED — filtering happens inside it, sourced from the active mode.

**Design (revised after pre-flight, 2026-07-15):** `parser.ts` already imports
`ModeManager` and resolves the active mode internally for type validation
(`validTypes` from `mode.observation_types`). The original "keep the parser
pure, caller passes allowedConcepts" instruction was based on a wrong premise
and is WITHDRAWN: an optional param with no-op default would silently leave the
server-beta call sites (`processGeneratedResponse.ts:70,192`) unfiltered.
Instead: read `mode.observation_concepts` from the SAME mode object already
fetched for types — one source of truth, all three call sites
(`ResponseProcessor.ts:41`, `processGeneratedResponse.ts:70,192`) covered
automatically, mode-awareness (law-study, email-investigation, meme-tokens
vocabularies) for free. If the active mode declares no `observation_concepts`
(missing or empty), skip filtering entirely — a mode without a vocabulary must
not have its concepts destroyed.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/sdk/parser-concepts-whitelist.test.ts
import { describe, it, expect } from 'bun:test';
import { parseAgentXml, filterConcepts } from '../../src/sdk/parser.js';

const CANON = ['how-it-works', 'why-it-exists', 'what-changed', 'problem-solution',
               'gotcha', 'pattern', 'trade-off', 'deliberate-decision'];

function xmlWith(concepts: string[]): string {
  const items = concepts.map(c => `<concept>${c}</concept>`).join('');
  return `<observations><observation><type>discovery</type><title>t</title>${items}</observation></observations>`;
}

describe('filterConcepts', () => {
  it('splits kept/dropped against the allowed set', () => {
    const r = filterConcepts(['gotcha', 'frontend', 'routing'], new Set(CANON));
    expect(r.kept).toEqual(['gotcha']);
    expect(r.dropped).toEqual(['frontend', 'routing']);
  });
});

describe('parseAgentXml concepts whitelist (active mode = code)', () => {
  it('drops topic words, keeps canonical (incl. deliberate-decision)', () => {
    const res = parseAgentXml(xmlWith(['frontend', 'deliberate-decision', 'bug']), 1);
    expect(res.valid).toBe(true);
    if (res.valid) expect(res.observations[0].concepts).toEqual(['deliberate-decision']);
  });

  it('still removes the observation type from concepts', () => {
    const res = parseAgentXml(xmlWith(['discovery', 'gotcha']), 1);
    if (res.valid) expect(res.observations[0].concepts).toEqual(['gotcha']);
  });

  it('does not drop the observation when all concepts are filtered (title is content)', () => {
    const res = parseAgentXml(xmlWith(['frontend', 'ui']), 1);
    expect(res.valid).toBe(true);
    if (res.valid) {
      expect(res.observations).toHaveLength(1);
      expect(res.observations[0].concepts).toEqual([]);
    }
  });
});
```

Adjust `xmlWith` to the parser's actual expected XML shape — read the fixtures in existing parser tests first (`tests/` has parser coverage; mirror their element names exactly; the placeholder names in `plugin/modes/code.json` — `xml_concept_placeholder` etc. — show the intended tags).

These tests run against the ACTIVE mode (parser resolves it via ModeManager, the
same way `validTypes` already works) — mirror whatever setup the existing parser
tests use for mode/type validation (real default `code` mode or a mock). The
`deliberate-decision` case requires the updated `plugin/modes/code.json`
(committed 71d8d522). Also add one mode-awareness case following that setup
pattern: with a mode whose `observation_concepts` is empty/missing, concepts
pass through unfiltered.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/sdk/parser-concepts-whitelist.test.ts`
Expected: FAIL — `filterConcepts` not exported / concepts not filtered.

- [ ] **Step 3: Implement**

In `src/sdk/parser.ts`:

```typescript
// FORK: write-time vocabulary enforcement. The model ignores the prompt-level
// enum at scale (50% of stored concept values were off-vocabulary; the Z.AI
// endpoint silently ignores response_format/json_schema, so constrained
// decoding is unavailable). The parser is the one chokepoint every
// observation passes through.
export function filterConcepts(
  concepts: string[],
  allowed: ReadonlySet<string>,
): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const c of concepts) {
    (allowed.has(c) ? kept : dropped).push(c);
  }
  return { kept, dropped };
}
```

In `parseAgentXml`, right after the existing type-leak filter
(`cleanedConcepts = concepts.filter(c => c !== finalType)`), filter against the
vocabulary of the SAME `mode` object the function already resolves for
`validTypes` (do not resolve the mode a second time):

```typescript
    // FORK: vocabulary enforcement from the same mode object used for types —
    // one source of truth, applies to all parseAgentXml callers (worker +
    // server-beta). A mode without observation_concepts declares no vocabulary
    // and gets no filtering.
    const allowedConcepts = new Set((mode.observation_concepts ?? []).map(c => c.id));
    let finalConcepts = cleanedConcepts;
    if (allowedConcepts.size > 0) {
      const { kept, dropped } = filterConcepts(cleanedConcepts, allowedConcepts);
      finalConcepts = kept;
      if (dropped.length > 0) {
        recordConceptDrops(dropped, correlationId);
      }
    }
```

(Adapt the variable name to whatever the function actually calls its resolved
mode; if type validation resolves it inside a narrower scope, hoist the mode
lookup so types and concepts share one resolution.) Use `finalConcepts` in the
pushed observation. The empty-observation skip check keeps using
title/facts/narrative — verify it does not gain a dependency on `finalConcepts`
being non-empty beyond what it already had with `cleanedConcepts` (if it
currently includes `cleanedConcepts.length === 0` in the all-empty condition,
keep that reading from `finalConcepts` — an observation whose ONLY content was
invalid concepts should still be skipped).

Drop-stats sink (same file or a small sibling module):

```typescript
function recordConceptDrops(dropped: string[], correlationId?: string | number): void {
  logger.debug('PARSER', 'Dropped off-vocabulary concepts', { correlationId, dropped });
  try {
    const line = JSON.stringify({ ts: Date.now(), dropped, correlationId: correlationId ?? null });
    appendFileSync(join(DATA_DIR, 'state', 'concept-drops.jsonl'), line + '\n');
  } catch {
    // stats are best-effort; never fail parsing over them
  }
}
```

Resolve `DATA_DIR` the way the rest of the SDK does (look at how `paths`/`CLAUDE_MEM_DATA_DIR` is imported in neighboring files; `~/.claude-mem/state/` already exists).

- [ ] **Step 4: Verify all call sites are covered (no caller changes)**

`grep -rn "parseAgentXml" src/ --include="*.ts"` — expected call sites:
`ResponseProcessor.ts:41` (worker) and `processGeneratedResponse.ts:70,192`
(server-beta). Because filtering is internal to `parseAgentXml`, all of them
get the whitelist with NO caller edits — confirm none of them pre- or
post-process concepts in a way that bypasses the parser.

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test tests/sdk/ && bun run typecheck`
Expected: PASS, including pre-existing parser tests (back-compat: no filtering when the param is omitted).

- [ ] **Step 6: Commit**

```bash
git add src/sdk/parser.ts tests/sdk/parser-concepts-whitelist.test.ts
git commit -m "feat(observer): enforce mode concept vocabulary at parse time, log drop stats"
```

---

### Task 2: Ranking replay harness in scripts/

**Files:**
- Create: `scripts/rank-replay.ts`
- Reference implementation: `/private/tmp/claude-501/-Users-ormequ-Development-tools-claude-mem/01cd33e0-0551-4326-8125-0fad2bd8e340/scratchpad/replay.py` (port it; if the scratchpad is gone, the logic is fully specified below)

**What it does:** replays ranking variants against REAL by-file rows from the live DB and prints killer ranks. This is the gate for ANY future ranking change (three variants died to it already: concepts-boost — regression 6→21; rare-concepts — 6→7; pure-what-changed demotion — no-op, premise 0/40).

- [ ] **Step 1: Implement the script**

```typescript
// scripts/rank-replay.ts
//
// FORK tool: replay read-hook ranking variants against live DB rows.
// Usage:
//   bun scripts/rank-replay.ts --project kedo \
//     --file "resources/js/Pages/Dev/Gallery.vue" --killer 24717 \
//     --file "app/Services/Bitrix24/AbsencesImporter.php" --killer 25165 --killer 25175
//
// Rule (FORK_NOTES): no ranking change ships without a green run here —
// every killer stays in the top-15 and the change beats 'upstream' on a
// stated metric. Fixtures for ranking tests come from real rows only.
import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';

const DISPLAY_LIMIT = 15;

interface Row {
  id: number; title: string | null; type: string; created_at_epoch: number;
  files_read: string | null; files_modified: string | null; concepts: string | null;
}

function parseArr(s: string | null): string[] {
  if (!s || !s.startsWith('[')) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}

function dedup(rows: Row[]): Row[] {
  const seen = new Set<string>(); const out: Row[] = [];
  for (const o of rows) {
    const key = (o.title ?? '').toLowerCase().replace(/\s+/g, ' ').trim() || `no-title-${o.id}`;
    if (!seen.has(key)) { seen.add(key); out.push(o); }
  }
  return out;
}

function specificity(o: Row, target: string): number {
  const fr = parseArr(o.files_read), fm = parseArr(o.files_modified);
  const total = fr.length + fm.length;
  const inMod = fm.some(f => f.replace(/\\/g, '/').endsWith(target));
  let s = 0;
  if (inMod) s += 2;
  if (total <= 3) s += 2; else if (total <= 8) s += 1;
  return s;
}

// Register candidate variants here. 'upstream' is the shipped scorer — keep
// it byte-equivalent to deduplicateObservations in src/cli/handlers/file-context.ts.
const VARIANTS: Record<string, (o: Row, target: string) => number> = {
  upstream: specificity,
};

function rank(rows: Row[], target: string, scorer: (o: Row, t: string) => number): number[] {
  return dedup(rows)
    .map(o => ({ o, s: scorer(o, target) }))
    .sort((a, b) => b.s - a.s) // stable: ties keep newest-first DB order
    .map(x => x.o.id);
}

// --- arg parsing: pairs of --file <path> followed by its --killer <id>s ---
const args = process.argv.slice(2);
let project = 'kedo';
const files: { path: string; killers: number[] }[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--project') project = args[++i];
  else if (args[i] === '--file') files.push({ path: args[++i], killers: [] });
  else if (args[i] === '--killer') files[files.length - 1].killers.push(Number(args[++i]));
}
if (files.length === 0) {
  console.error('usage: bun scripts/rank-replay.ts [--project p] --file <path> [--killer <id>]... [--file ...]');
  process.exit(1);
}

const db = new Database(join(homedir(), '.claude-mem', 'claude-mem.db'), { readonly: true });
for (const f of files) {
  const rows = db.query<Row, [string, string, string]>(`
    SELECT id, title, type, created_at_epoch, files_read, files_modified, concepts
    FROM observations
    WHERE (files_modified LIKE '%' || ? || '%' OR files_read LIKE '%' || ? || '%')
      AND (project = $p OR merged_into_project = $p)
    ORDER BY created_at_epoch DESC LIMIT 40
  `).all(f.path, f.path, { $p: project } as never);
  console.log(`\n=== ${f.path} (raw=${rows.length}) ===`);
  for (const [name, scorer] of Object.entries(VARIANTS)) {
    const order = rank(rows, f.path, scorer);
    const marks = f.killers.map(k => {
      const r = order.indexOf(k) + 1;
      return `#${k}: rank ${r || 'absent'} ${r > 0 && r <= DISPLAY_LIMIT ? 'IN' : 'OUT'}`;
    });
    console.log(`  ${name.padEnd(20)} ${marks.join(' | ') || `top3=${order.slice(0, 3).join(',')}`}`);
  }
}
```

Fix the `bun:sqlite` parameter-binding details against the actual API (mixed positional + named binding as sketched may need splitting into two bound params; verify by running). The LIKE-based file match is a known simplification vs the production `json_each` exact match — acceptable for a replay gate, note it in the header comment.

- [ ] **Step 2: Run it and verify against known baseline**

Run: `bun scripts/rank-replay.ts --project kedo --file "resources/js/Pages/Dev/Gallery.vue" --killer 24717 --file "app/Services/Bitrix24/AbsencesImporter.php" --killer 25165 --killer 25175`
Expected: all three killers `IN` (upstream baseline: #24717 rank ~6-7, #25175 ~7, #25165 ~10).

- [ ] **Step 3: Record the gate rule in FORK_NOTES**

Append to the read-hook section of `FORK_NOTES.md`:

```markdown
- Ranking changes to the read-hook are gated by `scripts/rank-replay.ts`
  (replays variants against live DB rows): every known killer observation
  stays in the top-15 AND the change beats `upstream` on a stated metric,
  or it does not ship. Ranking-test fixtures come from real DB rows only —
  a fabricated fixture already shipped one verified regression (concepts
  boost, 2026-07-15: #24717 rank 6 → 21). Withdrawn ranking ideas are
  listed in docs/bug-fixes/2026-07-11-read-hook-delivery-reliability.md —
  read them before proposing a new one.
```

- [ ] **Step 4: Commit**

```bash
git add scripts/rank-replay.ts FORK_NOTES.md
git commit -m "feat(tools): ranking replay harness gating read-hook scoring changes"
```

---

### Measurement protocol (manual, ~2 weeks after deploy — owner runs it)

1. Distribution: `deliberate-decision` share among new rows should be rare (<3%); mean concepts per new observation should drop from ~2.1 toward ~1.5; zero off-vocabulary values in DB (whitelist guarantees this — verify as a smoke check).
2. Drop-stats: `~/.claude-mem/state/concept-drops.jsonl` — top dropped values = the model's real vocabulary demand. A concept id gets legalized only with a consumer + this evidence.
3. Precision: 20 random new rows tagged `deliberate-decision` — how many record an actual explicit decision/revert? Plus one controlled test: perform a deliberate revert in a session, check it gets tagged.
4. Green on 1-3 → design an epoch-gated ranking variant and take it through `scripts/rank-replay.ts`. Red → the signal idea dies quietly and ranking stays upstream forever.
