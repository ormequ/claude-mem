# Assorted fork deltas

Small, self-contained changes that do not need a section of their own.

- Maintainer directives live in `CLAUDE.local.md` (gitignored), not the tracked
  `CLAUDE.md`. Upstream `e29d2213` moved its own maintainer sections there
  because the marketplace install is a git clone, so every tracked file ships to
  end users and their agents then obey those directives. The fork's guardrails
  (project-scoped queries must match the adopt pointer; reads stay cross-harness)
  moved with them — recreate `CLAUDE.local.md` on a fresh checkout, it is not in
  source control. These notes stay the durable copy.
- `mcp-server.ts` ListTools composes both gates:
  `getAdvertisedMcpToolsForRuntime(enabledTools, selectRuntime())` — upstream's
  runtime visibility filter fed the fork's smart-tools-gated list, not the raw
  `tools`. `tests/servers/mcp-runtime-tool-visibility.test.ts` greps for that
  exact source string, so it carries a one-line fork delta.

- `server-beta` `observation_add` / `memory_add` sends `content` while keeping
  `narrative` as a legacy alias.
- MCP `projectId` handling accepts useful aliases such as `ACME` and ignores raw
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
