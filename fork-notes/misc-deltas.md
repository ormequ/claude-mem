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
- Unconfigured provider idles (owner decision, v13.35 merge). Upstream's
  provider-dispatch falls through to `claude` whenever the selected provider
  (`openrouter`, `gemini`, `openai-compatible`) has no key/endpoint, which bills
  the Claude subscription for memory the user routed elsewhere — and with the
  fork's `openai-compatible` default, every fresh install would do so.
  `selectedProviderUnconfigured()` (provider-dispatch.ts) names the provider and
  the missing settings; `SessionRoutes.ensureGeneratorRunningLocked` checks it
  only when dispatch returned `claude`, so an explicit `claude`, `codex`, the
  opt-in quota fallback and the cmem-gateway trial fallback are unchanged. Then
  no generator starts, the gateway probe claim is released, the buffered work
  stays queued for the periodic resume sweep, and one `logger.warn` per 10
  minutes names the provider and settings. The Telegram wrap-up throws in the
  same state instead of using the SDK. Known ceiling: the in-RAM buffer grows
  until the provider is configured or the worker restarts. Not covered:
  `getAiStatus` (worker-service.ts) still reports `claude` in that state.
  The upstream suite assumes upstream's `claude` default; `tests/preload.ts`
  pins `CLAUDE_MEM_PROVIDER=claude` in env when unset (a seeded settings file is
  not enough: many tests rewrite the shared data dir's settings.json). Tests of
  the fork default read `getAllDefaults()` or pin the env themselves.
  Guards: `tests/worker/provider-dispatch.test.ts` (predicate) and
  `tests/worker/http/routes/session-routes-unconfigured-provider.test.ts`.
- `prime_corpus` / `query_corpus` use the selected HTTP provider's
  `/chat/completions` endpoint instead of the Claude Agent SDK when
  `CLAUDE_MEM_PROVIDER` is `openai-compatible` (endpoint, key and model from
  `resolveOpenAICompatConfig`) or `openrouter`, so corpus Q&A needs no Claude
  OAuth (`KnowledgeAgent.chatCompletionsEndpoint`; upstream only has the SDK
  path). A selected but unconfigured HTTP provider throws instead of falling back
  to the SDK. In this mode `prime` is idempotent (an existing synthetic session id
  is returned as-is); the SDK path primes every time, as upstream, so its
  auto-reprime of an expired session works. Upstream's client-disconnect abort
  signal is forwarded to the fetch. Guard:
  `tests/worker/knowledge-agent-openrouter-corpus.test.ts`.
- Worker launch behavior is fixed so normal installs start the worker instead
  of relying on a brittle `--daemon` path.
- OpenCode: upstream's V1/V2 plugin (v13.35.0) now covers what the fork carried —
  tool args from the hook input, `platformSource`, user prompts, per-project
  memory injection via `experimental.chat.system.transform`, the last assistant
  reply for summaries, and the worker keying the project from `cwd` (the same
  resolver as Claude Code). The fork's `index.ts`/`runtime.ts` were dropped for
  upstream's; dropped with them: the idle-summary dedup and the `project=` scope
  on `claude_mem_search`. Still fork-only: the installer's skill-set install and
  newest-bundle selection in `findBuiltPluginPath`.
- Dropped in the v13.35 merge: the fork's background corpus priming
  (`KnowledgeAgent.requestPrime`, a queued/pending/try-again-later `prime_corpus`
  reply that kept a cold prime from failing the tool call on a worker timeout),
  and the fork's 5-minute `query_corpus` HTTP timeout
  (`CLAUDE_MEM_CORPUS_QUERY_TIMEOUT_MS`). Upstream now streams corpus prime/query
  over SSE with an idle timeout (`CorpusRoutes.runLongCorpusWork`, MCP
  `streamCorpusProgress`), which covers both (#2822). The prime route is
  upstream's and always answers `{ session_id, name }`.
- Knowledge-agent Q&A (corpus query) can use a stronger model than bulk
  generation: `CLAUDE_MEM_OPENAI_COMPAT_QA_MODEL` / `CLAUDE_MEM_OPENROUTER_QA_MODEL`
  (concrete id or a `$TIER:smart` alias) is used for answers, falling back to
  that provider's `_MODEL` when unset. Keeps bulk observation/summary on the
  cheap model while corpus answers use a stronger one (fewer hallucinations).
- `search` / `build_corpus` honor the `adopt` soft-merge pointer end to end:
  both the FTS/no-query SQLite filter (`buildFilterClause`) and the
  semantic-result ID hydration (`getObservationsByIds` /
  `getSessionSummariesByIds`) match `project = ? OR merged_into_project = ?`
  (mirroring the session-start inject path). Without the hydration half, text-query
  (Chroma) search re-dropped adopted rows the vector search had matched. Adopted
  worktree observations are now visible to manual search and corpus builds scoped
  to the parent project, not just to automatic context injection. **Dropped in
  v13.35:** upstream converged (`projectScopeSql(…, { includeMerged: true })` in
  `buildFilterClause`, the ID hydrations and by-file); the fork only extends it to
  prompts (see `adoption.md`, "The session pointer").
- Session-start retrieval counting: `generateContextWithStats` returns
  `injectedObservationIds` (the delivered prefix — `stats.observation_count` of
  the fitted list) and `/api/context/inject` bumps `relevance_count` for them
  after responding (`sqlite/observations/relevance.ts`). Since v13.35 a block the
  SessionStart hook serves from upstream's context cache never reaches the route,
  so cached starts are not counted.
- Session-start summaries count sessions, not rows: `querySummariesMulti` takes
  only each session's newest content-bearing summary (investigated / learned /
  completed / next_steps / notes), so `sessionCount` means distinct sessions, and
  each summary is shown at its own time (no `SUMMARY_LOOKAHEAD` row, no
  `displayTime` borrowed from the previous session). Since v13.35 this is a
  `NOT EXISTS` newer-row probe inside upstream's per-key recency union, so the
  recency indexes are still walked. `SUMMARY_LOOKAHEAD` stays exported only for
  the server-runtime path (`ServerContextRows`). Tests:
  `tests/context/observation-compiler.test.ts`,
  `tests/context/newest-per-project-key.test.ts`.
- The fork's `syncOutboxEnabled` SessionStore option (skip `sync_outbox` writes
  when cloud sync is not configured) was dropped in v13.35: upstream ships the
  same gate as `syncOpsEnabled`, plus a boot-time purge of undrainable ops.

## Project identity

- `CLAUDE_MEM_PROJECT_ROOT` (fork-only env var, top of `getProjectContext` in
  `src/utils/project-name.ts`) is **deprecated** since the v13.35 merge in favour of
  upstream's `CLAUDE_MEM_PROJECT_ENVIRONMENTS`, which covers the same need — several
  directories, including a non-git folder holding several git repos, sharing one
  memory bucket — from settings rather than per-launch env. It still works, and logs
  one `PROJECT_NAME` warning per process pointing to the replacement.
- Precedence: `CLAUDE_MEM_PROJECT_ROOT`, when set, only **replaces the cwd** that
  every other rule resolves from. Then, as upstream: a matching
  `CLAUDE_MEM_PROJECT_ENVIRONMENTS` entry names the project; else the origin slug
  when `CLAUDE_MEM_PROJECT_NAME_SOURCE=git-remote`; else the path rules (git
  toplevel with worktree/submodule composites, then the nearest
  `.claude-mem-project` / `.claude-mem.json` marker, then the basename). So an
  environment pattern that covers the configured root wins over its folder name,
  and derived keys stay readable aliases in `allProjects`. Before the merge the
  override returned a bare `{primary}` context (no aliases, no worktree composite);
  the primary key is unchanged for a plain repo or folder root.
- Environments match against the session cwd itself, so `~/work/acme/**` names a
  session started anywhere inside a nested repo (`~/work/acme/api/src`) `acme`, with
  the repo's own name kept as a readable alias. Tests:
  `tests/utils/project-name-environments.test.ts` (nested repo subdirectory),
  `tests/utils/project-name.test.ts` ("CLAUDE_MEM_PROJECT_ROOT override").
