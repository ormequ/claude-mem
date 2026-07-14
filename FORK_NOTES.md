# claude-mem fork notes

This fork keeps local claude-mem fixes in source control instead of patching
`~/.claude/plugins/cache` or installed marketplace files by hand.

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
  - `compact` — essentials only: `knowledge-agent`, `mem-search`,
    `learn-codebase`
  - `full` — every bundled skill (no filtering)
- Legacy `CLAUDE_MEM_INSTALL_ALL_SKILLS=true` still maps to `full`;
  `CLAUDE_MEM_SKILL_SET` takes precedence when both are set.
- `knowledge-agent` is included by default because the fork enhances its corpus
  Q&A path (`CLAUDE_MEM_OPENROUTER_QA_MODEL`, below).

## Local fixes carried by the fork

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
- `PreToolUse:Read` ranking: `deduplicateObservations` in
  `src/cli/handlers/file-context.ts` gets an **additive** `+2` boost for
  decision-carrying concepts (`decision`, `gotcha`, `trade-off`,
  `problem-solution`), applied after the upstream specificity score. Type is
  never a sort key or filter — simulation-verified to bury the deliberate-revert
  class (#24717, `type=change`). Display cap stays 15.
  The delta is **deliberately inline, not extracted**: the function and its
  whole scoring block are upstream code (`origin/main` carries it). Extracting
  it to a fork-owned module would take permanent ownership of an upstream
  function — every upstream touch becomes a modify/delete conflict to hand-port,
  and upstream ranking improvements get silently shadowed. Extraction pays off
  only for fork-authored logic (see `file-staleness.ts` below). The fork also
  exports `deduplicateObservations` + `ObservationRow` so the fork test can
  import them.
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
- `CLAUDE_MEM_SMART_TOOLS=false|0` removes `smart_search`/`smart_unfold`/
  `smart_outline` from MCP registration (both ListTools and CallTool) and drops
  `smart-explore` from the default skill set. Default: enabled (upstream
  parity). `compact` never shipped smart-explore; `full` stays unfiltered by
  contract.

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
  `merged_into_project` by-file scoping, concepts boost, header trim — all
  above) never touch the allow/deny decision. Keep it that way.

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

## Upgrade checklist

After rebasing or merging upstream:

1. Rebuild generated bundles with `bun run build`.
2. Run `bun run typecheck`.
3. Run the fork-focused tests:
   `bun test tests/telemetry/consent.test.ts tests/integration/skill-selection.test.ts tests/integration/opencode-installer.test.ts tests/install-non-tty.test.ts tests/services/sqlite/observations-by-file-merged-scoping.test.ts tests/hooks/file-context.test.ts tests/hooks/file-context-ranking.test.ts tests/hooks/file-staleness.test.ts tests/services/infrastructure/adoption-scheduler.test.ts tests/shared/smart-tools.test.ts`.
4. Run `claude plugin validate .`.
5. Install from this checkout, not from a patched cache directory.
6. Smoke test:
   - `observation_add` with `projectId: "MKS"`
   - `memory_search` with a fresh marker
   - `query_corpus mks-smoke-test` with OpenRouter and no Claude OAuth

Do not treat edits under `~/.claude/plugins/cache` as durable fixes. Port them
back to source and rebuild/reinstall the fork.
