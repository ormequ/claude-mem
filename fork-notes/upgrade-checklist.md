# Upgrade checklist

After rebasing or merging upstream:

1. Rebuild generated bundles with `bun run build`.
2. Run `bun run typecheck`.
3. Run the fork-focused tests:
   `bun test tests/telemetry/consent.test.ts tests/integration/skill-selection.test.ts tests/integration/opencode-installer.test.ts tests/install-non-tty.test.ts tests/services/sqlite/observations-by-file-merged-scoping.test.ts tests/hooks/file-context.test.ts tests/hooks/file-context-ranking.test.ts tests/hooks/file-staleness.test.ts tests/services/infrastructure/ tests/shared/smart-tools.test.ts tests/services/sync/chroma-mcp-manager-singleton.test.ts tests/sdk/parser-type-fallback.test.ts`.
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
   Also run the **rate-limit guard** (`bun test tests/openrouter-rate-limit.test.ts`).
   A merge that reverts the `retry.ts` rate-limit branch fails it — see
   "Rate limits on the OpenAI-compatible path" for what to re-apply.
4. Run `claude plugin validate .`. Note a shell wrapper/alias around `claude`
   can swallow the subcommand ("Input must be provided … when using --print") —
   call the binary directly (`$(which -a claude | tail -1) plugin validate .`).
5. Install from this checkout, not from a patched cache directory.
6. Verify the PIN, not the build log — see "Branch layout and the
   marketplace-pin trap". The version in the pinned `installPath` must carry
   `+fork.worker.`, and its `skills/` must hold exactly the chosen set.
7. Smoke test:
   - `observation_add` with `projectId: "ACME"`
   - `memory_search` with a fresh marker
   - `query_corpus mks-smoke-test` with OpenRouter and no Claude OAuth

Do not treat edits under `~/.claude/plugins/cache` as durable fixes. Port them
back to source and rebuild/reinstall the fork.
