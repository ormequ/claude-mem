# Worktree adoption: scheduler, registry, orphans

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
  independent of worktree discovery — see `chroma.md`, "merge-patch drain" — so a
  starved tick no longer loses Chroma updates, only delays SQLite adoption of
  newly-merged branches.)
- `adopt-mem --orphans` reviews memory left by DELETED worktrees
  (`src/services/infrastructure/OrphanAdoption.ts` + `scripts/adopt-orphans.ts`,
  both fork-owned). Every adoption path enumerates `git worktree list`
  (`WorktreeAdoption.ts:179`), so a worktree that no longer exists can never be
  adopted and its rows keep `merged_into_project IS NULL` forever. Measured
  2026-07-20: 8 projects, ~3.9k rows invisible to `acme-app`-scoped queries. Root
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

## Sync-lane Chroma flag

- `WorktreeAdoption` sync-lane path re-nulls the Chroma flag itself. Upstream
  v13.12 routes the merged_into_project write through `emitRemapProject`
  (two-lane cloud sync) instead of the plain UPDATE when a sync lane exists —
  and that outbox knows nothing about `chroma_merge_synced_at`, so the remapped
  rows would never enter the worker's ChromaMergeDrain queue. The fork clears
  the flag on exactly those rows after the remap (`clearObsChromaFlag` /
  `clearSumChromaFlag`, keyed on the parent pointer the remap just wrote).
  Upstream's own `updateMergedIntoProject` now takes typed
  `MergedIntoProjectTarget[]` — it converged on the fork's obs/summary id
  collision fix, so that delta is gone; `ChromaMergeDrain` maps to it.
  `tests/services/infrastructure/worktree-adoption-chroma.test.ts` (upstream
  #3331) was rewritten to assert the queue, not an inline Chroma write.
