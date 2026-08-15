# `PreToolUse:Read` file-context hook

## Fork deltas

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
- `PreToolUse:Read` ranking: the **scoring** in `deduplicateObservations`
  (`src/cli/handlers/file-context.ts`) is **pure upstream specificity** —
  in-modified-file and total-files-touched, sorted descending, capped at 15.
  Type is never a sort key or filter. The fork's remaining delta inside that
  function is the dedup key, not the score: content-dedup by normalized title
  instead of upstream's `memory_session_id` (which kept only the newest
  observation per session — the blandest wrap-up — and dropped its
  decision-carrying siblings). An additive `+2` concept boost (`decision`, `gotcha`,
  `trade-off`, `problem-solution`) was tried and **reverted**: it demoted the
  very observation it was written to protect (#24717, the "deliberate
  revert" class, `type=change`) from rank 6 to rank 21 on live `acme-app` rows,
  because #24717's own concepts (`what-changed`, `how-it-works`) weren't in
  the boost set while 25 of 40 competing rows for the same file were — the
  boost lifted background noise, not the signal. The regression was invisible
  to the unit test because that test's fixture fabricated a `decision`
  concept onto the #24717-class row that the real observation never had.
  Caught by `scripts/rank-replay.ts` against real DB rows; see the gate rule
  below. Ranking stays pure upstream specificity until a replacement clears
  that gate.
  The delta is **deliberately inline, not extracted**: the function and its
  whole scoring block are upstream code (`origin/upstream` carries it). Extracting
  it to a fork-owned module would take permanent ownership of an upstream
  function — every upstream touch becomes a modify/delete conflict to hand-port,
  and upstream ranking improvements get silently shadowed. Extraction pays off
  only for fork-authored logic (see `file-staleness.ts` below). The fork also
  exports `deduplicateObservations` + `ObservationRow` so the fork test can
  import them.
- Ranking changes to the read-hook are gated by `scripts/rank-replay.ts`
  (replays variants against live DB rows): every known killer observation
  stays in the top-15 AND the change beats `upstream` on a stated metric,
  or it does not ship. Ranking-test fixtures come from real DB rows only —
  a fabricated fixture already shipped one verified regression (concepts
  boost, 2026-07-15: #24717 rank 6 → 21). Withdrawn ranking ideas are
  listed in docs/bug-fixes/2026-07-11-read-hook-delivery-reliability.md —
  read them before proposing a new one.
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

## Upstream baseline: `PreToolUse:Read` behavior (verified 2026-07-14)

Recorded to stop a recurring misread (the public doc is stale). `origin/upstream` is
treated as the upstream mirror here — it carries 0 fork commits (all of its
history is authored upstream); fork changes live on `main`.

- **Upstream ships `allow`, not `deny`.** On `origin/upstream`,
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
  `merged_into_project` by-file scoping, header trim — all above) never touch
  the allow/deny decision. Keep it that way.
