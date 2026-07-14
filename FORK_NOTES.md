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
- Smart file tools use the `tree-sitter-cli@0.26.x` query shape:
  `tree-sitter query --grammar-path <grammarPath> <queryPath> <files...>`.
- `smart_search` returns folded file views for file path/content matches even
  when no symbol name matched.
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
- Smart file tools support Vue/Svelte single-file components: the `<script>`
  body is parsed under its own grammar (TS/JS) with the surrounding markup
  blanked out so line numbers stay aligned. No SFC grammar needed.
- tree-sitter binary resolution is resilient: a 0-byte placeholder (left when the
  postinstall download is skipped/blocked) is ignored, and a working
  `tree-sitter` on PATH or a common location (`/opt/homebrew/bin`, cargo) is
  preferred over re-downloading from the GitHub release CDN (which some networks
  block). Install the CLI once with `brew install tree-sitter-cli` (0.26.x) if the
  bundled download is unavailable.
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
- The fork's only delta on this hook is the `#1719` mtime annotate flag and the
  `merged_into_project` by-file scoping (above) — not the allow/deny decision.

## Upgrade checklist

After rebasing or merging upstream:

1. Rebuild generated bundles with `bun run build`.
2. Run `bun run typecheck`.
3. Run the fork-focused tests:
   `bun test tests/telemetry/consent.test.ts tests/integration/skill-selection.test.ts tests/integration/opencode-installer.test.ts tests/install-non-tty.test.ts tests/services/sqlite/observations-by-file-merged-scoping.test.ts tests/hooks/file-context.test.ts`.
4. Run `claude plugin validate .`.
5. Install from this checkout, not from a patched cache directory.
6. Smoke test:
   - `observation_add` with `projectId: "MKS"`
   - `memory_search` with a fresh marker
   - `smart_outline` on a Go file
   - `smart_search grpcutil`
   - `query_corpus mks-smoke-test` with OpenRouter and no Claude OAuth

Do not treat edits under `~/.claude/plugins/cache` as durable fixes. Port them
back to source and rebuild/reinstall the fork.
