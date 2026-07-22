# claude-mem fork notes

This fork keeps local claude-mem fixes in source control instead of patching
`~/.claude/plugins/cache` or installed marketplace files by hand.

Installing it? Follow `INSTALL_FORK.md` — an agent runbook that asks the human
for the skill set, the harnesses, and whether to drop the `smart_*` MCP tools
before touching anything. Installing with defaults is how the picker silently
ends up on `default`. This file stays the authority on *why* those defaults
differ; INSTALL_FORK.md is the *how*.

## Runtime policy

- Worker runtime remains the default runtime for this fork.
- Server beta fixes are kept in source, but server beta is not the default
  runtime until its project separation and event viewer behavior are fully
  aligned with worker runtime.
- Claude Code, OpenCode, and future harnesses should share project identity by
  workspace/project alias rather than by harness name.

## Fork defaults

- Telemetry is off by default.
  - `CLAUDE_MEM_TELEMETRY=1` enables anonymous telemetry.
  - `CLAUDE_MEM_TELEMETRY=0` and `DO_NOT_TRACK=1` keep it off.
  - The installer prompt defaults to no.
- The installed skill set has three modes, chosen via `CLAUDE_MEM_SKILL_SET`
  (`default` | `compact` | `full`; unset → `default`). Extra bundled skills stay
  available in source for development but are removed from the installed skills
  directory unless the mode keeps them.
  - `default` — core + reports, plus `knowledge-agent`:
    - `mem-search`, `smart-explore`, `learn-codebase`, `how-it-works`,
      `timeline-report`, `weekly-digests`, `standup`, `pathfinder`,
      `knowledge-agent`
  - `compact` — memory core + the situational tools worth a permanent slot:
    `knowledge-agent`, `mem-search`, `pathfinder`, `timeline-report`.
    `learn-codebase` was dropped (2026-07-16): it brute-reads every file to
    front-load context, which `codegraph` (queried on demand) makes dead weight
    in an indexed repo. `pathfinder` (architecture audit before a refactor) took
    its slot — not "memory", but a heavy tool actually reached for.
    `timeline-report` is the one narrative report kept; `weekly-digests` reads
    the same whole-history data as serial per-week chapters ("If the user wants
    a single sweeping report, use timeline-report instead" — its own SKILL.md),
    so shipping both duplicates one source in two formats.
  - `full` — every bundled skill (no filtering)
- `CLAUDE_MEM_INSTALL_EXTRA_SKILLS` extends the `default` or `compact` set
  with comma-separated bundled skill directory names; for example,
  `CLAUDE_MEM_SKILL_SET=compact CLAUDE_MEM_INSTALL_EXTRA_SKILLS=babysit,weekly-digests`.
  Names are trimmed and deduplicated. Unknown names abort the install and list
  the available bundled skills. `full` validates configured names but retains
  every bundled skill.
- Legacy `CLAUDE_MEM_INSTALL_ALL_SKILLS=true` still maps to `full`;
  `CLAUDE_MEM_SKILL_SET` takes precedence when both are set.
- `knowledge-agent` is included by default because the fork enhances its corpus
  Q&A path (`CLAUDE_MEM_OPENROUTER_QA_MODEL`, below).

## Local fixes carried by the fork

- **All project-level memory reads are cross-harness (reverts the read path of
  upstream `348d9ee4` "scope memories by platform source").** Upstream joins
  each observation/summary to its originating `sdk_sessions.platform_source` and
  returns only rows produced by the *same* harness — so a Codex session in a
  project whose memory was built under Claude Code sees "no memory yet" (inject)
  and empty results (search) despite sharing the project id. The fork strips
  that scoping on every read path, in two places:
  - **Session-start injection + welcome hint.** `ObservationCompiler`
    (`queryObservationsMulti` / `querySummariesMulti` / `countObservationsByProjects`)
    no longer takes/applies `platformSource`; `ContextBuilder` and the
    `/api/context/inject` welcome-hint gate stop threading it. Re-sync: re-drop
    the `AND (? IS NULL OR s.platform_source = ?)` clause from those three
    compiler queries. Tests: `tests/context/observation-compiler.test.ts`,
    `tests/worker/http/routes/search-routes-welcome-hint.test.ts`.
  - **Search / timeline** (`mem-search`, MCP `search`, `/api/search`,
    `/api/context/semantic`). `SearchManager.normalizeParams` now always
    `delete`s `platformSource` / `platform_source`, so the downstream Chroma
    where-filters, FTS, and SQLite hydration never receive one. The upstream
    `platformScopedChromaZeroFallback` branch is now unreachable via the public
    `search()` API. Re-sync: re-apply the always-delete in `normalizeParams`.
    Tests: `tests/worker/search-manager.test.ts`,
    `tests/worker/SearchManager.timeline-anchor.test.ts (g)`,
    `tests/worker/http/routes/search-routes-platform-header.test.ts`.
  - **by-file + `SearchOrchestrator`** (`/api/search/by-file`, the strategy
    layer). `SearchOrchestrator.normalizeParams` mirrors the SearchManager
    always-delete (its `executeWithFallback` platform-scoped-zero branch is now
    inert). Re-sync: re-apply there too. Tests:
    `tests/worker/search/search-orchestrator.test.ts`,
    `tests/worker/search/strategies/hybrid-search-strategy.test.ts`.
  - **DataRoutes hydration + by-file + browse lists** (`/api/observation/:id`,
    `/api/session/:id`, `/api/prompt/:id`, `/api/observations/batch`,
    `/api/observations/by-file`, and the paginated `/api/observations` /
    `/api/summaries` / `/api/prompts`). These stopped threading the request's
    `platform_source` into `getObservationById` / `getObservationsByIds` /
    `getSessionSummariesByIds` / `getUserPromptsByIds` /
    `getObservationsByFilePath` / `PaginationHelper`. This is not cosmetic:
    cross-harness search returns ids from any platform, so a detail/hydration
    fetch that re-scoped would 404 a valid cross-platform id (the exact bug the
    updated test asserts is gone). Re-sync: drop the
    `getOptionalPlatformSourceFromRequest` calls in those read handlers and
    `parsePaginationParams`. Test:
    `tests/worker/http/routes/data-routes-platform-scoping.test.ts`.
  **Deliberately still platform-aware:** write-time `platform_source` tagging;
  per-session recovery; the server-runtime (Postgres `/v1/search`) path;
  `/api/projects` source-grouping (`handleGetProjects` returns a distinct
  `{sources, projectsBySource}` shape — an explicit viewer grouping, not
  memory-content scoping); and the display metadata that annotates each row with
  its originating platform. The MCP tool schemas still accept a `platformSource`
  param on worker reads but it is ignored (descriptions updated to say so).
- `server-beta` `observation_add` / `memory_add` sends `content` while keeping
  `narrative` as a legacy alias.
- MCP `projectId` handling accepts useful aliases such as `MKS` and ignores raw
  UUID project IDs instead of using them as project aliases.
- `query_corpus` uses an OpenRouter-compatible `/chat/completions` request when
  `CLAUDE_MEM_PROVIDER=openrouter`, avoiding Claude Code SDK/OAuth.
- Worker launch behavior is fixed so normal installs start the worker instead
  of relying on a brittle `--daemon` path.
- OpenCode install registers the plugin, injects shared memory context, and uses
  the same project memory as Claude Code for the same workspace.
- `prime_corpus` cold-start behavior returns a queued/try-again-later response
  instead of failing the tool call on a worker timeout.
- Knowledge-agent Q&A (corpus query) can use a stronger model than bulk
  generation on the OpenRouter path: `CLAUDE_MEM_OPENROUTER_QA_MODEL` (concrete id
  or a `$TIER:smart` alias) is used for answers, falling back to
  `CLAUDE_MEM_OPENROUTER_MODEL` when unset. Keeps bulk observation/summary on the
  cheap model while corpus answers use a stronger one (fewer hallucinations).
- `search` / `build_corpus` honor the `adopt` soft-merge pointer end to end:
  both the FTS/no-query SQLite filter (`buildFilterClause`) and the
  semantic-result ID hydration (`getObservationsByIds` /
  `getSessionSummariesByIds`) match `project = ? OR merged_into_project = ?`
  (mirroring the session-start inject path). Without the hydration half, text-query
  (Chroma) search re-dropped adopted rows the vector search had matched. Adopted
  worktree observations are now visible to manual search and corpus builds scoped
  to the parent project, not just to automatic context injection.
- The `PreToolUse:Read` per-file context path also honors the `adopt` soft-merge
  pointer, and no longer suppresses on mtime. The `by-file` lookup
  (`getObservationsByFilePath`) matches `project IN (…) OR merged_into_project IN (…)`
  (mirroring inject/search), so worktree feature-work merged into the parent is
  visible when the file is Read from the main checkout — previously it was scoped
  to the raw `project` slug only and silently missed. The `#1719` mtime gate
  switched from suppress to annotate: observations older than the file's last edit
  are surfaced with a `⚠ may be stale` marker instead of being hidden (a merge or
  checkout bumps the working file's mtime past every worktree observation, which
  had been silencing exactly the merged feature-work). See
  `docs/bug-fixes/2026-07-11-read-hook-delivery-reliability.md`.
- `PreToolUse:Read` ranking: the **scoring** in `deduplicateObservations`
  (`src/cli/handlers/file-context.ts`) is **pure upstream specificity** —
  in-modified-file and total-files-touched, sorted descending, capped at 15.
  Type is never a sort key or filter. The fork's remaining delta inside that
  function is the dedup key, not the score: content-dedup by normalized title
  instead of upstream's `memory_session_id` (which kept only the newest
  observation per session — the blandest wrap-up — and dropped its
  decision-carrying siblings). An additive `+2` concept boost (`decision`, `gotcha`,
  `trade-off`, `problem-solution`) was tried and **reverted**: it demoted the
  very observation it was written to protect (#24717, the "deliberate
  revert" class, `type=change`) from rank 6 to rank 21 on live `kedo` rows,
  because #24717's own concepts (`what-changed`, `how-it-works`) weren't in
  the boost set while 25 of 40 competing rows for the same file were — the
  boost lifted background noise, not the signal. The regression was invisible
  to the unit test because that test's fixture fabricated a `decision`
  concept onto the #24717-class row that the real observation never had.
  Caught by `scripts/rank-replay.ts` against real DB rows; see the gate rule
  below. Ranking stays pure upstream specificity until a replacement clears
  that gate.
  The delta is **deliberately inline, not extracted**: the function and its
  whole scoring block are upstream code (`origin/main` carries it). Extracting
  it to a fork-owned module would take permanent ownership of an upstream
  function — every upstream touch becomes a modify/delete conflict to hand-port,
  and upstream ranking improvements get silently shadowed. Extraction pays off
  only for fork-authored logic (see `file-staleness.ts` below). The fork also
  exports `deduplicateObservations` + `ObservationRow` so the fork test can
  import them.
- Ranking changes to the read-hook are gated by `scripts/rank-replay.ts`
  (replays variants against live DB rows): every known killer observation
  stays in the top-15 AND the change beats `upstream` on a stated metric,
  or it does not ship. Ranking-test fixtures come from real DB rows only —
  a fabricated fixture already shipped one verified regression (concepts
  boost, 2026-07-15: #24717 rank 6 → 21). Withdrawn ranking ideas are
  listed in docs/bug-fixes/2026-07-11-read-hook-delivery-reliability.md —
  read them before proposing a new one.
- The `⚠ may be stale` marker is keyed to the file's last *content* change
  (`git log -1 --format=%ct -- <path>`, mtime fallback for dirty/untracked/
  non-git and any git failure) instead of raw mtime — a merge/checkout no longer
  marks every entry stale (`src/cli/handlers/file-staleness.ts`, fork-owned:
  upstream has no counterpart). ~20ms warm; runs only when the by-file query
  returned observations, not on every Read.
- The read-hook injection header is two lines: `Current:` plus one line folding
  the `get_observations` hint. The per-injection `codegraph`/`smart_outline`
  hint is gone — transcript audit showed such hints are almost never acted on,
  and the global CLAUDE.md already mandates codegraph-first in indexed repos.
- Merged-worktree adoption re-runs hourly in the worker
  (`src/services/infrastructure/AdoptionScheduler.ts`, fork-owned), not just at
  startup: the worker lives for weeks, so a branch merged between restarts was
  invisible to project-scoped queries until someone ran `adopt`. Skips ticks
  while a run is in flight, survives runner failures, unrefs the timer.
- Adoption discovers its repo list from a durable registry
  (`src/services/infrastructure/KnownCwdRegistry.ts`, fork-owned;
  `~/.claude-mem/state/known-cwds.json`), unioned with the live queue.
  `adoptMergedWorktreesForAllKnownRepos` previously read cwds ONLY from
  `pending_messages` — a queue whose rows are deleted the moment an observation
  is processed, so it is empty almost always. Discovery then resolved zero
  repos and returned early at a `logger.debug` line that is never written to
  the log file, which made both callers (the worker-boot pass AND the hourly
  tick above) silent no-ops: the hourly re-run this fork added had, in
  practice, never adopted anything except by the lottery of a message being
  in flight at the exact tick instant. Measured 2026-07-16: a manual `adopt`
  left `chromaFailed=384`, and the next tick logged nothing at all.
  The registry records RAW cwds, not resolved repo roots — resolving costs a
  `git rev-parse` subprocess and the recording site (`SessionManager`'s
  observation enqueue, upstream, one line) is a per-tool-call hot path; a
  known cwd costs one Set lookup and no I/O. Adoption resolves lazily, as it
  already did. Dead paths (removed worktrees) are pruned on write.
  (Historical note: this discovery bug used to also starve the Chroma retry,
  because adoption patched Chroma inline and relied on the next scan to repair a
  failed patch. Since 2026-07-19 Chroma patching is a durable SQLite-flag drain
  independent of worktree discovery — see "Chroma merge-patch" below — so a
  starved tick no longer loses Chroma updates, only delays SQLite adoption of
  newly-merged branches.)
- `adopt-mem --orphans` reviews memory left by DELETED worktrees
  (`src/services/infrastructure/OrphanAdoption.ts` + `scripts/adopt-orphans.ts`,
  both fork-owned). Every adoption path enumerates `git worktree list`
  (`WorktreeAdoption.ts:179`), so a worktree that no longer exists can never be
  adopted and its rows keep `merged_into_project IS NULL` forever. Measured
  2026-07-20: 8 projects, 3886 rows invisible to `kedo`-scoped queries. Root
  cause was an orca archive hook that was never wired (`automations: []`), so
  `scripts/adopt-mem` never ran on deletion — the CLI is the cleanup path and
  the backstop for deletions that bypass the hook (`git worktree remove` by
  hand).
  It does NOT decide whether a branch merged: adoption on deletion is
  unconditional by design (`--branch` skips the merged-check entirely,
  `WorktreeAdoption.ts:188-190`), so the tool shows facts and a human approves.
  The only upstream edit this cost: `gitCapture` and `resolveMainRepoPath` in
  `WorktreeAdoption.ts` gained `export` (two words, nothing else).
  `listWorktrees` stays unexported and unreused — its upstream body never
  parses `prunable`, and teaching it to would be a behavioral delta on
  upstream logic — so the fork ships its own copy in `OrphanAdoption.ts`.
  Two traps worth keeping. First: a worktree deleted with `rm -rf` stays in
  `git worktree list` (flagged `prunable`) until `git worktree prune`, so
  presence in that listing does not mean live — liveness is decided by
  `existsSync` on the directory. The `prunable` flag is NOT load-bearing:
  mutation testing 2026-07-21 showed an implementation ignoring it entirely
  still passes every test, because a prunable entry whose directory still
  exists and still resolves to a `parent/child` project name is not
  constructible (git only sets the flag once the gitdir target is missing).
  It is kept in the code as defense in depth only. Second: the parent project
  name is a repo basename, so it maps to a SET of repo roots — two clones
  collide, and picking one arbitrarily would report the other's live
  worktrees as deleted. Declines live in
  `~/.claude-mem/state/orphan-decisions.json` with a timestamp and lapse once
  the project gains rows newer than the decline, so a reused worktree name
  can't inherit an old `n`. The comparison parses both operands with
  `Date.parse` and fails open (not suppressed) on `NaN`, because a raw string
  compare would sort a non-ISO value like SQLite's `datetime('now')` below
  every ISO decline (space `0x20` < `T` 0x54) and suppress that project
  forever with no signal.
- `CLAUDE_MEM_SMART_TOOLS=false|0` removes `smart_search`/`smart_unfold`/
  `smart_outline` from MCP registration (both ListTools and CallTool) and drops
  `smart-explore` from the default skill set. Default: enabled (upstream
  parity). `compact` never shipped smart-explore; `full` stays unfiltered by
  contract.
  **It is env-only — `~/.claude-mem/settings.json` does NOT work for it.** Two
  independent reasons: `smartToolsEnabled()` reads `process.env` directly and
  never consults settings, and `SettingsDefaultsManager.loadFromFile` copies
  only keys present in its `DEFAULTS` whitelist, which does not carry
  `CLAUDE_MEM_SMART_TOOLS` — an entry there is silently dropped. The MCP server
  loads no settings file at all, so env is its only channel. Set it in the
  `env` block of `~/.claude/settings.json`; `plugin/.mcp.json` spawns the
  server with `stdio: 'inherit'`, so Claude Code's env propagates. This is a
  deliberate inconsistency with every other setting (which is settings.json-
  driven): routing it through `SettingsDefaultsManager` would put a fork delta
  in an upstream file and buy merge cost, while `smart-tools.ts` is fork-owned.
  Note a `permissions.deny` on the `smart_*` tools is **not** equivalent — it
  blocks calls but leaves the tools registered, so their schemas still cost
  context. Removal from registration is the point.
  **Any test asserting the `default` skill set must `delete
  process.env.CLAUDE_MEM_SMART_TOOLS` in `beforeEach` and restore it after.**
  A dev box that sets the gate in `~/.claude/settings.json` has it propagated
  into the test env by Claude Code, so `smart-explore` is absent from the
  default set and the assertion fails locally while passing in CI — a
  developer-only red that reads as a real break. Bit
  `skill-selection.test.ts` first and `opencode-installer.test.ts` again on
  2026-07-17.

- `src/sdk/parser.ts` enforces the active mode's `observation_concepts`
  vocabulary at parse time (`filterConcepts`, `recordConceptDrops`, and the
  mode-sourced filter block inside `parseObservationBlocks`) — upstream code
  now carrying a fork-specific delta. The model ignores the prompt-level enum
  at scale (50% of stored concept values were off-vocabulary, 28,404/56,954
  measured 2026-07-15), and the Z.AI coding endpoint silently ignores
  `response_format: json_schema`, so constrained decoding is not available;
  write-time filtering at the parser is the one chokepoint all three callers
  pass through (`ResponseProcessor.ts:41`, `processGeneratedResponse.ts:70,192`),
  so none of them need caller-side changes. The vocabulary comes from the SAME
  `mode` object already resolved for `validTypes` — one source of truth, and
  `parseAgentXml`'s signature is deliberately unchanged. A mode that declares
  no `observation_concepts` is a strict no-op (concepts pass through
  unfiltered). Drop stats land in `~/.claude-mem/state/concept-drops.jsonl`.
- `plugin/modes/code.json` concept discipline (2026-07-15): `concept_guidance`
  switched to sparse tagging (0-2 concepts, only central, empty valid, anti-topic
  block), a `deliberate-decision` concept was added (strict criteria: explicit
  choice/revert a future agent must not undo), and the enum reminder is repeated
  in the prompt footer. Inherited by `code--chill`. Rationale: measured 50%
  off-vocabulary concept values (28,404/56,954); prompt variants all pass in
  small contexts, so the failure is long-context attention — the paired
  write-time whitelist lives in `src/sdk/parser.ts` (above); the plan at
  `.plan/2026-07-15-observer-concepts-discipline.md` records the rationale.
  Vocabulary governance: new concept ids only with a concrete consumer AND
  drop-stats evidence (`~/.claude-mem/state/concept-drops.jsonl`).

## Dropped: smart-file-read / tree-sitter fork work (2026-07-14)

The fork no longer carries any smart-file-read delta. `codegraph` replaced
tree-sitter for code structure, so these fixes were abandoned rather than
re-applied:

- the `tree-sitter-cli@0.26.x` `--grammar-path` query shape,
- resilient binary resolution (0-byte placeholder ignored, PATH/homebrew/cargo
  preferred over the release CDN),
- Vue/Svelte SFC `<script>` parsing,
- `smart_search` folded file views — this one is upstream behavior now.

State as of the v13.11.0 merge: `src/services/smart-file-read/parser.ts` and
`search.ts` are byte-identical to `origin/main`. The fork test that covered the
above (`tests/services/smart-file-read-fork-fixes.test.ts`) was deleted — it had
been failing at import (`ensureTreeSitterCliBinary` no longer exists), and all
its remaining cases failed too because tree-sitter parsing returns no symbols
here.

**The generated `plugin/package.json` no longer ships tree-sitter** (fork delta in
`scripts/build-hooks.js`, which generates that manifest — editing
`plugin/package.json` directly is pointless, the build overwrites it). Dropped
`tree-sitter-cli`, all 25 grammars, the `tree-sitter` `overrides` entry, and
`trustedDependencies`. Rationale: `tree-sitter-cli` was the *only* trusted
dependency — the only one Bun runs an install script for — and that script
downloads a binary from the GitHub release CDN, which this network blocks. Every
`bun install` in the plugin folder therefore failed, and a failed sync aborts
**before** `sync-marketplace.cjs` filters skills, silently widening the skill
picker back to all 18. The grammars are ~495 MB of dead weight without the CLI.
Plugin deps are now just `zod` + `shell-quote` (2 installs / 3 packages).

Note the repo-root `package.json` still carries the tree-sitter dev deps, and
`sync-marketplace.cjs` rsyncs the whole repo, so `bun install` at the
*marketplace root* still resolves them — use `bun install --ignore-scripts` there
if node_modules ever needs rebuilding.

Do not re-add these on the next upstream merge. Use `codegraph explore` for
structure. The `PreToolUse:Read` header no longer hints at any structure tool
(it briefly pointed at `codegraph` in `a1e7180f`); `CLAUDE_MEM_SMART_TOOLS=false`
removes the `smart_*` tools from MCP registration entirely.

## Upstream baseline: `PreToolUse:Read` behavior (verified 2026-07-14)

Recorded to stop a recurring misread (the public doc is stale). `origin/main` is
treated as the upstream mirror here — it carries 0 fork commits (all `main`
history is authored upstream); fork changes live on `fork-fixes`.

- **Upstream ships `allow`, not `deny`.** On `origin/main`,
  `src/cli/handlers/file-context.ts` returns `permissionDecision: 'allow'`: it
  lets the full Read through and injects the observation timeline as
  `additionalContext` ("… The Read result below is the full requested section.").
  It does **not** block/substitute reads.
- **Upstream tried deny and rejected it — twice, for independent reasons:**
  - `c8076339` — deny on first read, allow on re-read (in-memory session gate,
    4h TTL). Abandoned by…
  - `455aeaf6` — allow-on-retry silently bypassed the timeline on the second
    read, hiding freshly-created observations → switched to deny-every-read.
    Abandoned by…
  - `d0676aa0` ("file-read gate **allows Edit**") — deny broke the harness
    Read-before-Edit invariant (a denied Read never registers, so `Edit`/`Write`
    fail with "must Read first"). Switched deny→allow (initially `limit:1`, later
    the full read on current `main`). `codegraph`/MCP output does not satisfy the
    invariant either — only the built-in Read tool registers a file.
  So deny is settled-rejected upstream: (a) hides fresh observations on retry,
  (b) breaks Edit. Re-adopting it re-introduces both.
- ⚠ **`docs/public/file-read-gate.mdx` is STALE.** It still documents the
  abandoned deny/block behavior ("blocks the read and instead shows a compact
  timeline"). Do not treat it as current; the code is allow-mode.
- The fork's deltas on this hook (mtime→annotate, git-content staleness,
  `merged_into_project` by-file scoping, header trim — all above) never touch
  the allow/deny decision. Keep it that way.

## Runbook: Chroma corruption recovery

Symptom: chroma-mcp subprocess death-spiral — repeated segfaults or `-32001`
errors on every vector call; transport retry and watermark backfill do not
recover because the index files themselves are corrupted (nothing detects
file-level corruption).

Fix (safe — Chroma is a derived cache; SQLite is the source of truth, nothing
is lost):

1. Stop the worker.
2. Delete `~/.claude-mem/chroma/` and the Chroma sync-state file
   (`sync-state.json` under `~/.claude-mem/`).
3. Restart the worker — the startup "smart backfill" rebuilds the vector index
   from SQLite. Search degrades to FTS-only until the rebuild finishes.

If this recurs a third time, automate it (subprocess-death counter →
quarantine + rebuild); until then the manual ritual is cheaper than the code.

## Chroma merge-patch: SQLite flag drained by the worker (2026-07-19)

Adoption no longer writes to Chroma at all. It only sets `merged_into_project`
in SQLite and resets a `chroma_merge_synced_at` flag (added to `observations`
and `session_summaries`) to NULL, which enqueues the row. The worker patches
Chroma from that queue via `drainChromaMergeQueue`
(`src/services/sync/ChromaMergeDrain.ts`, fork-owned) — on startup and after
each `AdoptionScheduler` tick, in the ONE process that holds the Chroma
single-writer lock.

Why this replaced the old "adoption patches Chroma directly, CLI retries via
worker" design:

- The CLI `adopt` command runs in its OWN process, so its `ChromaSync` built a
  fresh `ChromaMcpManager` and tried to open a second persistent writer over
  `~/.claude-mem/chroma`. The writer-lock guard correctly refused
  (`Chroma data dir … is already owned by PID <worker>; refusing to start a
  second writer`), so every CLI adopt printed a scary `chromaFailed=N`. Do NOT
  "fix" that by relaxing the pid/ownerId check in `ChromaMcpManager` — a second
  manager in one process spawns a second chroma-mcp over the same store, the
  2026-07-11 multi-instance incident the lock exists to prevent.
- The old retry re-derived the patch set by re-scanning git worktrees
  (`merged_into_project IS NULL OR merged_into_project = ?`). If the worktree
  was deleted right after `adopt_mem` (before the hourly tick), the scan no
  longer found it as a target and those rows stayed unpatched in Chroma
  forever. The flag is durable SQLite state, so deletion can't strand rows.

Properties of the drain: patches by `sqlite_id` AND `doc_type` (obs vs summary
ids collide in the single `cm__claude-mem` collection); stamps the flag only
after a chunk's Chroma patch succeeds (resumable — a mid-run failure keeps
patched chunks stamped and leaves the rest NULL for the next tick); rows whose
flag defaults to NULL after the column migration are picked up automatically,
so the first run backfills all pre-existing merged rows. Chroma is a derived
cache, so a redundant no-op patch (row merged before its first Chroma sync) is
harmless — the normal insert path already carries `merged_into_project`.

The CLI adopt output now prints `Chroma patch: N rows queued (worker patches on
next drain)` instead of the old updated/failed counters.

## Upgrade checklist

After rebasing or merging upstream:

1. Rebuild generated bundles with `bun run build`.
2. Run `bun run typecheck`.
3. Run the fork-focused tests:
   `bun test tests/telemetry/consent.test.ts tests/integration/skill-selection.test.ts tests/integration/opencode-installer.test.ts tests/install-non-tty.test.ts tests/services/sqlite/observations-by-file-merged-scoping.test.ts tests/hooks/file-context.test.ts tests/hooks/file-context-ranking.test.ts tests/hooks/file-staleness.test.ts tests/services/infrastructure/ tests/shared/smart-tools.test.ts tests/services/sync/chroma-mcp-manager-singleton.test.ts`.
   Run them with the sandbox disabled — it denies reads of `./node_modules`,
   so every test that imports a real dependency dies at module resolution
   ("Cannot find module '@modelcontextprotocol/sdk/…'") and reads as a code
   failure when nothing is wrong.
   Also run the **cross-harness read guardrails** (one per layer that upstream
   `348d9ee4` scopes — see "All project-level memory reads are cross-harness"):
   `bun test tests/context/observation-compiler.test.ts tests/worker/http/routes/search-routes-welcome-hint.test.ts tests/worker/search-manager.test.ts tests/worker/SearchManager.timeline-anchor.test.ts tests/worker/http/routes/search-routes-platform-header.test.ts tests/worker/search/search-orchestrator.test.ts tests/worker/search/strategies/hybrid-search-strategy.test.ts tests/worker/http/routes/data-routes-platform-scoping.test.ts`.
   A merge that reintroduces `platform_source` filtering on any read path fails
   these — that is the signal to re-drop it (inject/ObservationCompiler,
   SearchManager, SearchOrchestrator, DataRoutes) before shipping.
4. Run `claude plugin validate .`.
5. Install from this checkout, not from a patched cache directory.
6. Smoke test:
   - `observation_add` with `projectId: "MKS"`
   - `memory_search` with a fresh marker
   - `query_corpus mks-smoke-test` with OpenRouter and no Claude OAuth

Do not treat edits under `~/.claude/plugins/cache` as durable fixes. Port them
back to source and rebuild/reinstall the fork.
