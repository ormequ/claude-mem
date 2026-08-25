# Observation vocabulary, types, and the extraction prompt

## Concept vocabulary enforced at parse time

- `src/sdk/parser.ts` enforces the active mode's `observation_concepts`
  vocabulary at parse time (`filterConcepts`, `recordConceptDrops`, and the
  mode-sourced filter block inside `parseObservationBlocks`) — upstream code
  now carrying a fork-specific delta. The model ignores the prompt-level enum
  at scale (50% of stored concept values were off-vocabulary, ~28k/57k
  measured 2026-07-15), and the Z.AI coding endpoint silently ignores
  `response_format: json_schema`, so constrained decoding is not available;
  write-time filtering at the parser is the one chokepoint all three callers
  pass through (`ResponseProcessor.ts:41`, `processGeneratedResponse.ts:70,192`),
  so none of them need caller-side changes. The vocabulary comes from the SAME
  `mode` object already resolved for `validTypes` — one source of truth, and
  `parseAgentXml`'s signature is deliberately unchanged. A mode that declares
  no `observation_concepts` is a strict no-op (concepts pass through
  unfiltered). Drop stats land in `~/.claude-mem/state/concept-drops.jsonl`.
  `filterConcepts` matches on a **canonicalized** form (case folded, runs of
  whitespace/`_` folded to `-`, repeats collapsed) and stores the canonical
  spelling, because the injection SQL matches exactly. Reading the drop stats
  2026-07-30 showed the whitelist eating `how it-works` 4 times — a vocabulary
  word lost to one space, while every other drop that day was a real topic word
  (`configuration` ×15, `verification` ×14, `architecture` ×14, `storage` ×11).
  A separator slip is a typo, not an off-vocabulary answer. Two spellings of one
  concept collapse to a single entry; `dropped` still records the raw string, so
  the stats stay diagnostic. This does NOT widen the vocabulary — `data quality`
  and `security_note` still drop, they are simply not in it.
  Upstream's #3379 colon truncation runs first (parse boundary), so
  `gotcha: WASM quirk` → `gotcha` → kept; the two compose in that order.
- `plugin/modes/code.json` concept discipline (2026-07-15): `concept_guidance`
  switched to sparse tagging (0-2 concepts, only central, empty valid, anti-topic
  block), a `deliberate-decision` concept was added (strict criteria: explicit
  choice/revert a future agent must not undo), and the enum reminder is repeated
  in the prompt footer. Inherited by `code--chill`. Rationale: measured 50%
  off-vocabulary concept values (~28k/57k); prompt variants all pass in
  small contexts, so the failure is long-context attention — the paired
  write-time whitelist lives in `src/sdk/parser.ts` (above); the plan at
  `.plan/2026-07-15-observer-concepts-discipline.md` records the rationale.
  Vocabulary governance: new concept ids only with a concrete consumer AND
  drop-stats evidence (`~/.claude-mem/state/concept-drops.jsonl`).

## Observation type vocabulary and extraction prompt (2026-08-03)

One shipment, kept deliberately lopsided: almost all of it is `plugin/modes/code.json`
(data, merges cleanly), and the code deltas are one line each in six upstream files plus
one fork-owned module. Rationale and measurements live in
`.scratches/2026-08-03-work-inventory.md`; only the re-sync-relevant facts are here.

- **`plugin/modes/code.json`, `version` 1.0.0 → 1.1.0.** Two types added — `finding` (a
  conclusion: verdict, root cause, measured result) and `failed_attempt` (an approach tried
  and abandoned, with the reason). `type_guidance` rewritten: it had claimed "EXACTLY one of
  these 6 options" while `observation_types` declared 8, so `security_alert` / `security_note`
  reached the model in the skeleton with no definition at all. Each of the 10 is now defined,
  `bugfix` is narrowed to "diagnosed AND repaired", `decision` is widened from "architectural
  choice" to "a course chosen or reversed" (96% of what an explicit decision request produces
  was not typed `decision`), and a discovery/finding/decision discriminator plus a
  "where decisions appear" block were added. `recording_focus` gained: the answer rather than
  the route, abandoned approaches, user-confirmed choices, and a LANGUAGE section. Bump
  `version` on any further prompt edit — it is what the `prompt_version` tag records.
- **`src/sdk/parser.ts` — the type fallback is `change`, not `validTypes[0]`.** One line.
  `validTypes[0]` is `bugfix` in the code mode, so every observation the model emitted
  without a `<type>` was stored as a bug fix: all 78 empty-title rows in the store are
  `bugfix`, and `bugfix` held 9.4% of records while 81.9% of them modified no file. No prompt
  wording can fix this — the fallback is in the parser. Re-sync: re-apply the
  `validTypes.includes('change')` guard. Test: `tests/sdk/parser-type-fallback.test.ts`
  (fork-owned; runs against the real `code` mode, not a stub, because what is under test is
  the interaction between the shipped type list and the fallback).
- **`src/sdk/parser.ts` — an off-vocabulary type is coerced to that same fallback (2026-08-24),
  not stored as emitted.** Upstream preserved whatever the model wrote. At scale the model
  invents a type per observation rather than picking one, and an invented type is dropped
  silently by every consumer filtering on type while type shares stop adding up — a share
  metric cannot be read across the onset date. The parser is the only chokepoint, so the fix
  is there: coerce, and append the emitted string to `~/.claude-mem/state/type-coercions.jsonl`
  through the same best-effort appender as the concept drops, so the rate stays measurable
  without the row carrying an unusable value. Re-sync: re-apply the `validTypes.includes(type)`
  branch. Tests: the coercion case in `tests/sdk/parser-type-fallback.test.ts`, and the
  upstream test in `tests/sdk/parser.test.ts` that asserted preservation, inverted.
  Not done: a backfill. Rows written before the fix keep their emitted type — rewriting them
  would erase what the model actually said, and the onset date is the honest boundary.
- **`AskUserQuestion` removed from the `CLAUDE_MEM_SKIP_TOOLS` default**
  (`src/shared/SettingsDefaultsManager.ts`, one line). It was dropped at ingest
  (`worker/http/shared.ts:73`), so the observer never saw it — while its result carries the
  option a human actually chose, which is the least recoverable signal in the system and
  leaves no commit, no MR and no file. Volume is a handful of calls per session. `TodoWrite` /
  `Skill` / `SlashCommand` / `ListMcpResourcesTool` stay skipped. `ExitPlanMode` was never in
  the list, so approved plans always came through. Re-sync: drop it from the default again.
- **Memory is written AND queried in English** (DEC-06 amendment, see
  `.scratches/2026-07-31-audit-decisions.md`). Chroma runs an English-only embedder, so a
  Russian query lands in a region where texts are similar by script rather than meaning and
  returns confident, unrelated results — an all-English corpus does not fix that, because the
  *query* is what degenerates. Two read-side deltas: `plugin/skills/mem-search/SKILL.md`
  gained a "Query in English, always" section, and the `query` param description of the MCP
  `search` tool (`src/servers/mcp-server.ts`) says the same. Write side is the LANGUAGE block
  in `code.json`. This is what cancels the expensive DEC-06 remedies (multilingual embedder
  via ollama, re-embedding ~26k rows, a third runtime dependency) — do not re-open them
  without re-reading that amendment. **Corollary for any retrieval eval: write the questions
  in English, or it measures the embedder instead of the store.**
- **`prompt_version` tag on every observation**, as `<mode id>@<version>` (e.g. `code@1.1.0`),
  in the existing `metadata` JSON — read it with `json_extract(metadata, '$.prompt_version')`.
  Deliberately not a column: `metadata` is already threaded through the same INSERT, so this
  needs no migration and adds no schema delta for an upstream merge to collide with, and one
  `GROUP BY` still answers "did that prompt change help?". Logic lives in
  `src/services/worker/agents/prompt-version.ts` (fork-owned) so the delta inside upstream's
  `ResponseProcessor.ts` is an import plus one line in the existing `labeledObservations` map.
  The mode id comes from settings, not `mode.name`, which is a display string that differs per
  translation override. Not done: the embedder version tag — it belongs at the Chroma sync
  site and has no pending change to catch now that both sides are English.
- **Type unions widened** in `src/types/database.ts`, `src/services/sqlite/types.ts`,
  `src/services/worker/knowledge/types.ts` (one line each). They listed 6 types and had been
  stale since `security_alert` / `security_note` shipped; they are type hints only, runtime
  validation is data-driven from the mode.
- **`agent_type` is canonicalized at ingest** — `normalizeAgentType`
  (`src/shared/agent-type.ts`, fork-owned, beside `platform-source.ts` which does the same job
  for the same call site), applied in `worker/http/shared.ts` as a one-line delta. Case folded,
  runs of whitespace/`_` folded to `-`, empty → `undefined` so a blank tag never becomes a
  distinct value meaning "none". **Scope, stated because the measurement is unflattering:** it
  merges 530 of 10,082 tagged rows (`Explore` → `explore`) and takes the distinct count from
  467 to 466. It does NOT make `agent_type` a role dimension — the other 464 values are
  per-task agent instance names (`impl-mk-cluster-os`, `evidence-switch-auth`), which is
  DEC-18's finding; role filtering needs a mapping or a separate field. Test:
  `tests/worker/agent-type-normalization.test.ts`. Note the file lives in `src/shared/`, not
  under `services/worker/`, because `tests/logger-usage-standards.test.ts` requires every file
  under `services/worker/` to import the logger and a pure string helper has nothing to log.
- **Empty concepts pass the injection gate** (DEC-05). `ObservationCompiler`'s
  `EXISTS (SELECT 1 FROM json_each(o.concepts) WHERE value IN (…))` made a row with no
  concepts permanently invisible to session-start injection — while the 2026-07-15 prompt
  change deliberately made sparse tagging the norm ("0-2 concepts, only central, empty
  valid"). So the write side was told to emit nothing and the read side treated nothing as
  disqualifying. 734 rows were unreachable when this shipped, 674 of them in ACME, 17 of the
  last 200 ACME rows. NULL / `''` / `'[]'` now pass; an off-vocabulary tag is still excluded,
  so this does not widen the vocabulary. Re-sync: re-apply the `IS NULL OR trim(...) IN`
  branch. Test: `tests/context/observation-compiler.test.ts` (the same file that guards the
  cross-harness read delta).
- **DEC-09 was NOT implemented as specified, deliberately.** It asked for write-time
  suppression of the observer's false "no prior context found" records. Measured 2026-08-03:
  **5 such rows in ~26k**, and three or four of them were created by the audit's own test
  runs on 2026-07-31. A permanent filter in an upstream write path is not worth five rows, so
  the cause is addressed in `skip_guidance` instead — the observer is told it never receives
  the injected context and is not in a position to report its absence, with an explicit carve-
  out that genuine negative results in the observed work are still recorded (DEC-11: do not
  destroy negative knowledge). Revisit only if the count grows.

- **The `code--*` variants were NOT updated.** They are overrides deep-merged onto `code`
  (`ModeManager.parseInheritance`), so they inherit `observation_types` and `version`
  automatically — but they override `prompts`, which means a translated mode still carries the
  old 6-type guidance in its own language, and its LANGUAGE block would contradict the
  English rule. Switching `CLAUDE_MEM_MODE` to one of them is therefore a regression until
  they are re-translated. `code` is the default and the only one in use here.

  **`code--chill` closed 2026-08-17.** It is a tone variant, not a translation, so it should
  have kept the English rule — but it overrides `recording_focus` wholesale (deepMerge replaces
  strings) and so dropped the LANGUAGE block with it. The block is now repeated in the variant,
  and `tests/sdk/mode-language-rule.test.ts` asserts it for every non-translated mode that
  resolves from `code`. The translated variants stay as described above: they do not override
  `recording_focus` at all, so they currently inherit an English instruction that contradicts
  their own placeholders — deliberate, since re-translating 29 files buys nothing while none of
  them is in use. `law-study`, `meme-tokens` and `email-investigation` are separate base modes,
  not `code` variants, and were left alone.
