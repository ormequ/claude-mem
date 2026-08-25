# User prompts and the harness-review loop

## The `harness-review` skill

- **`harness-review` skill** (`plugin/skills/harness-review/`, fork-owned; added to
  `DEFAULT_CLAUDE_MEM_SKILLS` — an uninstalled skill cannot be invoked). Counts the user's own
  corrective prompts per week — total, nudges, hard corrections, "you forgot one", "you
  answered without looking", nudge chains — and requires every proposal to be mechanical and
  prompt-cited. Built RED-GREEN per `superpowers:writing-skills`: three baseline runs of the
  same task **without** the skill agreed on 1 finding out of ~15, and **none of the three
  noticed the store had not been written to for three days** — each read the healthy-looking
  ~26k total and moved on. With the skill, 2/2 stopped at the liveness gate and reported the
  outage as the finding. Two of the six counted categories came out of the baseline runs, not
  from the plan. Traps recorded in the skill: SQLite `lower()` does not fold Cyrillic; the
  audits wrote their own conclusions into `observations`, so a retro will "find" them and
  present them as new; and a last-timestamp check catches a stop but not a fade — observations
  per prompt slid 27.0 → 2.1 over four days while prompt volume doubled, before writes stopped.
- **`harness-review` v2.1.0 (2026-08-03)** — external review by two models found the v2.0.0
  liveness gate was never executable: `search(type="prompts", limit=1)` is rejected with
  `INVALID_SEARCH_REQUEST` because `SessionSearch` requires either a query or a filter
  (`src/services/sqlite/SessionSearch.ts`). Both GREEN runs "stopping at the liveness gate" may
  therefore have been stopping on an API error rather than diagnosing the outage; treat that
  validation as unproven. Also fixed: `allowed-tools` did not list the MCP tools the body
  requires; the blanket "subtract exact repeats within 5 minutes" rule deleted the repeated
  nudges the same skill calls its defensible floor; the output contract demanded prompt
  citations, which would have rejected its own accepted example (built on 40+ observations and
  zero prompts); a non-existent observation type `dead_ends` was referenced where
  `failed_attempt` was meant; the cursor was written as local time with a `Z` suffix, which
  pushes the next window three hours into the future and returns a clean period. Added: the
  ledger step (`~/.claude-mem/state/harness-ledger.md`, scored before anything else), a series
  file so each run's numbers survive, a guard for the cursor bug (live store + zero prompts is
  a contradiction), and a prohibition on reading the corrections-to-findings ratio while the
  extraction-prompt experiment is open, since that experiment moves the denominator. The
  baseline table is marked DISPUTED — it disagrees with two other documents claiming the same
  measurement date and no row-level source was kept.
- **`harness-review` v2.2.0 (2026-08-04) — the non-prompt lanes.** Up to v2.1.0 the skill read
  one signal: the user's corrective prompts. That lane has a ceiling and it moves on its own —
  a prompt exists only where a failure annoyed someone enough to type about it, and once the
  user starts pre-empting a defect ("and don't forget X") the complaint disappears while the
  defect stays. Step 4 adds two lanes computed from what the agent did, both direct SQL because
  `search` caps at 100 rows and cannot group. **Lane B, re-derived facts:** cluster observation
  titles per project, `sessions >= 3 AND days >= 3`; exact-title matching is a floor, so the
  count is never reported as "how much re-derivation happened". The list is then read for
  volatile (branch SHAs, task status, session bootstrap — re-deriving these is correct) versus
  stable (repo layout, a symlink, where a constant lives). Before proposing to document a stable
  fact, grep the project's `CLAUDE.md` for it: if it is already written and was re-derived
  anyway, the finding is about what gets read, not about what is missing. Never propose
  consolidating a cluster back into the store — a consolidated row outranks its own sources in
  retrieval and would show up as a success in every later measurement. **Lane C, worked-around
  errors:** a seeded signature list over `narrative`/`facts`/`title`; the span is the point —
  one signature ran 12 times across 12 sessions and stopped dead, which is a fix proving itself,
  while sandbox denials run 68 hits / 26 sessions / 18 days and reach today with zero prompts
  about them. The lane contaminates itself (its own output quotes the strings it greps for, and
  the newest hit on the first run was the query looking at itself), so the newest rows are read
  by hand. **Lane D, compliance:** of the prohibitions already written in the instruction files,
  which are obeyed — 441 observations read under `vendor/` and 258 read generated files against
  rules saying never to. This is the only lane that uses the review window (a cumulative count
  can only rise), and the only one that ever proposes *deleting* a rule: one that is never
  violated and never seen to fire is paid for on every injection and buys nothing.
  **Lane E, task outcomes: declared and not built** — it needs a task registry, and the
  skill says "not measured" rather than staying quiet, because in autonomous work (user assigns,
  never corrects) the prompt lane goes to zero and this file would otherwise print "no
  corrections found". The output contract now requires naming every lane including the empty
  and missing ones.

## Prompt reads

- **Full prompt text by id (2026-08-03).** `search(type="prompts")` renders each row through
  `FormattingService.formatUserPromptSearchRow`, which truncates `prompt_text` to 60
  characters — correct for an index view, but there was no way to read a prompt in full, so
  anything classifying prompts was classifying heads. Added `POST /api/prompts/batch`
  (`src/services/worker/http/routes/DataRoutes.ts`: schema, route, handler — mirrors
  `/api/observations/batch` line for line) and the `get_prompts` MCP tool
  (`src/servers/mcp-server.ts`). No new store code: `SessionStore.getUserPromptsByIds` already
  took an array and was reached only by the single-id route. The handler destructures
  `{ids, orderBy, limit, project}` and deliberately drops `platformSource`, exactly as the
  observations handler does — that is what keeps the read cross-harness per the guardrail.
  Re-sync: if upstream adds its own prompt batch route, drop ours and keep the MCP tool
  pointed at theirs.
- **`getUserPromptsByIds` LEFT JOINs `sdk_sessions` (2026-08-03).** It was an INNER join, so
  the 65 of 3051 prompts whose `session_db_id IS NULL` were unfetchable by id: `/api/prompt/:id`
  404s them and the batch route returns short without saying it dropped anything. Found by a
  labelling pass that requested 101 contiguous ids and got 36 — it reported the gap as missing
  rows, and the rows were in the table the whole time. `getObservationsByIds` already LEFT
  JOINs, so this was an inconsistency, not a design. A `project` filter still excludes these
  rows (the `s.project = ?` condition is NULL for them), which is correct — an unattributed
  prompt belongs to no project. One word in an upstream method; re-sync: re-apply `LEFT`.
- **Machine relays are filtered out of prompt reads (2026-08-15).** Delegate reports
  (`<agent-message from=…>`) and `<cross-session-message>` envelopes arrive on the same
  `UserPromptSubmit` hook as human text and are stored verbatim, so `search(type="prompts")` and
  the telemetry `prompt_count` metric reported them as things the user typed — 373 of 6251 rows
  store-wide, 17% of the last harness-review window. The predicate lives in
  `src/shared/user-prompts.ts` (fork-owned): `isMachineRelayPrompt` /
  `notMachineRelaySql`, matching on the envelope prefix.
  Applied in four upstream files, one expression each: `SessionSearch.searchUserPrompts` (SQLite
  path), `ChromaSearchStrategy` and `SearchManager` (both hydrate Chroma hits through
  `getUserPromptsByIds` — the SQLite-only fix missed them, caught by querying the live worker),
  and `services/telemetry/backfill.ts`. Re-sync: re-apply those four.
  **Filtered on read, not flagged at capture.** The envelope is already in `prompt_text`, so a
  `source` column would be derived data costing a migration, a `CloudSync`/`SyncApply` schema
  delta and a backfill — and would still leave existing rows unmarked. The row itself is kept:
  what a delegate reported is a real record, and `/api/prompt/:id` still returns it.
  **Deliberately unfiltered:** the FTS triggers and `ChromaSync` still index relays (Chroma's
  watermark/pending bookkeeping walks id sequences; excluding rows there would desync it), so a
  relay can still occupy a semantic top-k slot before being dropped; `timeline` still shows them,
  which is correct for a chronological record. Test: `tests/machine-relay-prompts.test.ts`.
  The harness-review skill drops the same envelopes before classification (commit `33b9eeec`);
  scoring lives in `~/.claude-mem/state/harness-ledger.md`, row 1.
  **Envelope-less injections (2026-08-24).** An orchestrator that injects a prompt without
  wrapping it is indistinguishable from the user, and one such injection repeated through a
  session was the single largest machine contributor to a review window. The list in
  `user-prompts.ts` therefore holds SQL LIKE *patterns*, not prefixes — one source for the SQL
  and the TS predicate, with the TS side translating LIKE to a regexp — and carries the two
  literal shapes alongside the envelopes. A pattern matches only a prompt that is nothing but
  the injection, so a human prompt with one appended is still the user's row. Growing this list
  is a last resort: an injector that wraps its output in an envelope is caught by shape and
  needs no entry. Not catchable at all: a relay a human pasted between terminals by hand, which
  needs the marker written by the relaying agent.
- **Reviews on disk:** `.scratches/2026-08-03-fable-harness-review-2.md`,
  `.scratches/2026-08-03-codex-harness-review.md`, `.scratches/2026-08-03-fable-task-retro.md`.
  `.scratches/` is gitignored, so these do not survive a fresh clone.
