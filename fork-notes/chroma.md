# Chroma: corruption recovery and merge-patch drain

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

Upstream's `project merge` (v13.35) feeds the same queue: its transaction nulls
the flag on the merged rows, and its own inline Chroma patch stamps them back on
success, so a failed patch is drained by the worker instead of waiting for a
re-run. See `adoption.md`, "`project merge`".

## Backfill: reconcile every sweep, ids from Chroma's SQLite, packed writes

Re-expressed on upstream v13.35's backfill (fragment reconciliation, corrupt
collection rebuild, shutdown handling) during the v13.35 merge:

- **Reconcile on every sweep** (`sweepAllProjects`). Upstream bootstraps
  watermarks from Chroma only when `chroma-sync-state.json` is missing. The
  watermark is a max(): the live sync path bumps it to the newest id while a
  backfill is still walking older rows, so after an aborted or interrupted run
  it sits above rows that were never embedded and `id > watermark` skips them
  for good, silently shrinking semantic search.
  `bootstrapWatermarksFromChroma` now runs every sweep and merges into the
  project's state: watermarks are recomputed, existing pending ids (fragment
  reconciliation rides on pending) and the rebuild / title-only flags are kept.
  The watermark is the project's own highest complete row (intersection), not
  the max id Chroma holds.
- **Ids from Chroma's SQLite** (`readChromaDocumentIds`). Paging
  `chroma_get_documents` behind a `where` filter re-scans on every page and did
  not finish on a large store; one read of `embeddings.embedding_id` (joined to
  this collection through `segments` / `collections`) takes seconds. Falls back
  to MCP paging when the file or schema is unreadable, or in remote mode.
- **Packed writes** (`backfillKind`). Whole rows share one write of up to
  `BATCH_SIZE` documents (a row wider than that goes alone, in slices, with the
  upstream shutdown check between slices). The per-call round trip dominates, so
  row-per-call ran ~3 rows/min on a large collection and packed ~37. A partial
  write keeps every row of that batch pending; three failed batches in a row stop
  the run (upstream's #3928 guard, now per batch). `ChromaSync.packBackfillRows
  = false` restores upstream's per-row shape; the upstream tests in
  `chroma-sync-watermarks.test.ts` run that way because they count per-row writes.
- **Sweep retry** (`backfillAllProjects`). Upstream sweeps once per worker
  start; an incomplete sweep (not a shutdown) is retried up to
  `backfillMaxAttempts` (12) times, `backfillRetryDelayMs` (5 min, unref'd timer)
  apart, so an unattended gap repair survives a blip.
- **Dropped because upstream covers it:** the `ChromaMcpManager.callTool`
  "only dispose the client you talked to" fix (upstream compares the call's
  transport, never tears down on a request timeout while a write may be in
  flight, and serializes mutations); the dead-batch abort (upstream's
  consecutive-failure guard); zero-document rows retired from pending (upstream
  drains them, #4069); `BATCH_SIZE = 50` (upstream gives mutations a 600 s
  deadline instead of the SDK's 60 s, so 100 no longer sits on the timeout).
