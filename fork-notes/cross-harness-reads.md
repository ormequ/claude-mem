# Cross-harness memory reads

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
    `/api/context/inject` welcome-hint gate stop threading it. Since v13.35 the
    observation query lives in `queryObservationsNewest` (per-key recency
    union) and `queryObservationsMulti` never passes `platformSource` to it; the
    option stays only for upstream's Grok Bot seat INDEX writer, a per-seat
    feed rather than a project memory read. `SearchRoutes.renderContextInjectBody`
    does not pass the request's platform into `generateContextWithStats` (the
    context cache is still keyed by it, which only duplicates identical
    variants); the server runtime (`/v1/context`) keeps it. Re-sync: re-drop the
    platform clause from `countObservationsByProjects` / `querySummariesMulti`
    and the `platformSource` argument of `queryObservationsMulti`. Tests: `tests/context/observation-compiler.test.ts`,
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
    inert). Since v13.35 upstream falls back to FTS on any empty Chroma answer,
    so the guardrail asserts that fallback call carries no platform either.
    Re-sync: re-apply there too. Tests:
    `tests/worker/search/search-orchestrator.test.ts`,
    `tests/worker/search/strategies/hybrid-search-strategy.test.ts`.
  - **DataRoutes hydration + by-file + browse lists** (`/api/observation/:id`,
    `/api/session/:id`, `/api/prompt/:id`, `/api/observations/batch`,
    `/api/observations/by-file`, the paginated `/api/observations` /
    `/api/summaries` / `/api/prompts`, and upstream's raw tool-use reads
    `/api/tool-uses` / `/api/tool-uses/batch`). These stopped threading the request's
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
  `/api/projects` source-grouping and the viewer's `/api/sessions` catalog (a
  session is identified by platform + content id) (`handleGetProjects` returns a distinct
  `{sources, projectsBySource}` shape — an explicit viewer grouping, not
  memory-content scoping); and the display metadata that annotates each row with
  its originating platform. The MCP tool schemas still accept a `platformSource`
  param on worker reads but it is ignored (descriptions updated to say so).
