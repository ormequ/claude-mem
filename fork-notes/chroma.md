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
