# Upgrade checklist

After rebasing or merging upstream:

0. Conflicts in generated files (`plugin/scripts/*`, `plugin/ui/*`, `plugin/sqlite/*`,
   `plugin/bun.lock`) are not resolved by hand: take upstream's copy
   (`git show upstream/main:<path>`, written through a script — the destructive-command
   guard blocks `git checkout --theirs`) and let step 1 regenerate them.
   `plugin/scripts/version-check.js` is the exception: it is hand-written and carries the
   portable `install-version.json` marker delta, so re-apply that after taking upstream's.
1. Rebuild generated bundles with `bun run build`. Until then the version test's
   "release version injected into built *.cjs" cases fail — the bundles carry
   upstream's version.
   **A build that bumps the version must be installed right away
   (`npm run build-and-sync`), not left in the checkout.** The worker-script
   resolver ranks `<cwd>/plugin/scripts/worker-service.cjs` among its
   candidates, so a session whose cwd is this checkout spawns the newer local
   worker, every other session's hook kills it as a version mismatch, and the
   two recycle each other — live sessions then hit "worker unreachable" on
   session-init. Seen 2026-10-12 during this very merge.
2. Run `bun run typecheck`.
3. Run the fork-focused tests:
   `bun test tests/telemetry/consent.test.ts tests/integration/skill-selection.test.ts tests/integration/opencode-installer.test.ts tests/install-non-tty.test.ts tests/services/sqlite/observations-by-file-merged-scoping.test.ts tests/hooks/file-context.test.ts tests/hooks/file-context-ranking.test.ts tests/hooks/file-staleness.test.ts tests/services/infrastructure/ tests/shared/smart-tools.test.ts tests/services/sync/chroma-mcp-manager-singleton.test.ts tests/sdk/parser-type-fallback.test.ts tests/npx-cli/fork-no-cmem-account.test.ts tests/npx-cli/prune-cache.test.ts tests/integration/t3code-installer.test.ts tests/setup-runtime.test.ts`.
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
   Also run the **provider-default guard**
   (`bun test tests/shared/settings-defaults-manager.test.ts`). Upstream defaults
   `CLAUDE_MEM_PROVIDER` to `claude`, which spends the Claude Code subscription
   on per-tool-call compression whenever settings.json names no provider; the
   fork defaults to upstream's `openai-compatible` provider, the path carrying
   the rate-limit patch. A merge that restores `claude` fails that test. The
   default is only half the guard: a selected but unconfigured HTTP provider
   must idle, not fall through to `claude` — guarded by
   `bun test tests/worker/http/routes/session-routes-unconfigured-provider.test.ts`
   (see `misc-deltas.md`, "Unconfigured provider idles").
   Two more fork defaults live in the same file: `CLAUDE_MEM_SKIP_TOOLS` without
   `AskUserQuestion`, and `CLAUDE_MEM_FILE_READ_GATE_ENABLED=false`
   (guard: `bun test tests/shared/file-read-gate-default.test.ts`).
   Also run the **rate-limit guard** (`bun test tests/openrouter-rate-limit.test.ts`).
   A merge that reverts the `retry.ts` rate-limit branch or the provider wiring
   fails it — see `provider-rate-limits.md` for what to re-apply.
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
