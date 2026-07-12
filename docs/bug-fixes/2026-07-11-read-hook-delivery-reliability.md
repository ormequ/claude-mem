# Bug report: PreToolUse:Read hook — delivery reliability + display quality

Filed 2026-07-11 by the kedo lead session, based on two independent audits of the
hook's real behavior in the `kedo` project. The hook's owner asked for a detailed
report; after these are fixed we will re-run the audits and re-evaluate whether
the hook stays enabled (re-evaluation criteria at the bottom).

**TL;DR:** the hook stays silent on the highest-value, correctly-tagged
observations (two reproducible cases below), while much of what it does inject
is stale, misattributed, or edit-chronicle noise. Measured value is currently
below its cost — but the concept is sound; the failures look fixable.

DB under test: `~/.claude-mem/claude-mem.db`, `observations` table. All
observation records below were re-fetched via `get_observations` and verified
verbatim by the lead (not just by the auditing subagent).

---

## Bug 1 (critical): per-file lookup misses observations from worktree-slug sessions even after merge

**Repro:**
1. Observations **#25165** and **#25175** exist:
   - `project: "kedo/bitrix24-deferred-absences"` (a git-worktree session slug)
   - `merged_into_project: "kedo"`
   - `files_modified` includes `"app/Services/Bitrix24/AbsencesImporter.php"`
     (#25175 also lists it in `files_read`)
   - decisive content: the 2026-07-09 “+1 day” absence-date bugfix
     (endOfDay→startOfDay alignment on both bounds)
2. From a session in the main checkout (`/Users/ormequ/Development/kedo`,
   project `kedo`), Read `app/Services/Bitrix24/AbsencesImporter.php`.
3. **Expected:** hook fires and surfaces #25165/#25175.
   **Actual:** hook is silent. Verified twice with fresh reads on 2026-07-11
   (subagent transcript). The hook is alive in the same session — it fired on
   `app/Http/Controllers/Invitation/InvitationController.php` moments earlier.

**Hypothesis:** the per-file index/lookup is scoped by the observation's
original `project` slug (or file paths are indexed at capture time under the
worktree project) and never re-joined via `merged_into_project`. Note that
`files_read`-only indexing does NOT explain it: #25175 lists the file in both
`files_read` and `files_modified` and is still missed. Project-slug scoping is
the prime suspect.

**Impact:** in this workflow all feature development happens in git worktrees
(pipeline convention), so the hook systematically misses exactly the
feature-work observations. This also explains the observed “random” firing
within one feature arc: `InvitationController.php` fires (has main-slug
history), `EmployeesImporter.php` / `EmployeeInvitation.vue` /
`tests/Feature/Bitrix24/EmployeesImporterTest.php` stay silent despite equal
recency and dense history.

**Secondary check worth doing while here:** the auditing agent hypothesized a
possible per-file-per-session dedup that a fresh subagent doesn't benefit from
(parent session consumed the injection → child gets nothing). Its own reads
were fresh and repeated, so dedup alone can't explain Bug 1, but please review
how dedup behaves across parent/teammate/subagent sessions of one Claude Code
session.

## Bug 2: unmerged observations are invisible to the hook while `search()` finds them instantly

**Repro:**
1. Observation **#24717** “Gallery Close Button Position Reverted”:
   - `project: "kedo"`, `merged_into_project: null`
   - `files_modified: ["resources/js/Pages/Dev/Gallery.vue"]`, `files_read: []`
   - captured by a subagent (`agent_type: general-purpose`) from an Edit
   - content is the textbook case the hook exists for: a deliberate revert
     (top-7 → top-10) that a naive agent would happily “fix” back
2. Read `resources/js/Pages/Dev/Gallery.vue` from the main checkout.
3. **Expected:** hook surfaces #24717. **Actual:** silent (verified twice).
   Full-text `search("Gallery close button")` finds it immediately.

**Questions for the owner:** what does `merged_into_project: null` mean for
hook visibility? Why does an observation captured under the main slug still
miss — do subagent-captured observations (agent_id set) index differently, or
does `files_modified`-only attribution (empty `files_read`) skip the file
index?

## Bug 3 (display quality): no resolved/superseded status — stale lines read as live bugs

**Evidence:** Read of `modules/Knowledge/src/Providers/KnowledgeServiceProvider.php`
surfaces “KnowledgeServiceProvider exists but fails to autoload” (2026-06-21)
with no resolution marker. The issue was fixed weeks ago; the file loads fine.
A naive agent starts debugging a non-bug — the injection is actively worse than
silence. Also observed: misattribution — an IDOR note about
`ApiTokenController::destroy` surfaces under `app/Models/User.php`.

**Suggestion:** display-side gating: (a) an explicit status field
(open/resolved/superseded) or at minimum an age suffix + “may be resolved”;
(b) only surface observations whose `files_read`/`files_modified` actually
contain the read path, not looser associations.

## Bug 4 (minor): doc reads get edit-chronicles

Doc files (`development.md`, `CLAUDE.md`, `QA_AGENTS.md`) fire on nearly every
read, but the injected lines are a chronicle of past editing sessions
(“Documentation condensed”, “policy documented”, “Repeated file reads”) — zero
decision value on top of the Read itself. Suggestion: suppress or de-prioritize
`type=change` meta-observations for doc paths, or observations whose only
relation to the file is “this file was edited”.

---

## Measured baseline (what “re-evaluate” will be compared against)

Two audits, 2026-07-11, kedo:

- **Transcript audit** (63 transcripts since 2026-07-01, exact counts): 114
  hook firings, ~25.3k tokens injected (~222/firing), only 0.6% of the 644
  offered observation-IDs were ever fetched via `get_observations`; 70% of
  sessions that received injections never pulled at all.
- **Qualitative audit** (16-file diverse sample, 0–2 scoring anchored in
  quotes): 0 load-bearing (score-2) injections; best case “marginal”; both
  hand-picked killer cases (Bugs 1–2 above) silent.

## Re-evaluation criteria (after fixes)

1. **Killer reads pass:** Read of `app/Services/Bitrix24/AbsencesImporter.php`
   surfaces #25165/#25175; Read of `resources/js/Pages/Dev/Gallery.vue`
   surfaces #24717 — from a main-checkout session, first read, no warm-up.
2. **No regressions in silence:** trivial/no-history files (e.g.
   `modules/Knowledge/src/Enums/AssessmentType.php`, `Makefile`) stay silent.
3. **Stale-line gating:** the KnowledgeServiceProvider “fails to autoload” line
   either carries a resolution/age marker or is not shown.
4. Then we re-run the 16-file qualitative pass; the hook stays if killer-class
   observations surface reliably and score-2 rate is non-zero.

---

## Post-fix smoke, 2026-07-11 ~21:00 (lead session, main checkout, fresh reads)

**Confirmed fixed:**
- Both killer files now FIRE (mtime gate → “⚠ may be stale (file edited
  since)” annotation instead of suppression — visible on every line, works).
- Worktree-slug observations reach main-checkout reads (`kedo/lunar-river`,
  `kedo/bitrix24-deferred-absences` entries shown) — the Bug-1 delivery path
  is clear.

**Still failing criterion 1 — for a third, now DB-verified reason:
within-result dedup by `memory_session_id` keeps only the NEWEST observation
per session per file, and the newest is systematically the blandest.**

Evidence (session IDs re-fetched via get_observations, not guessed):
- `AbsencesImporter.php` injection shows #25177 (“Final verification confirms
  targeted bugfix commit isolation and worktree state”, 19:36:43) — same
  `memory_session_id` (`openrouter-60ebd8cc-…`) as the hidden #25175
  (19:36:26, root cause + fix) and #25165 (19:35:14, the actual “+1 day”
  bugfix). The dedup picked the wrap-up note and dropped the decision-carrying
  siblings.
- `Gallery.vue` injection shows #24755 (“positioning synchronized”, 18:01) —
  same `memory_session_id` (`openrouter-844a1aff-…`) as the hidden #24717
  (“Gallery Close Button Position **Reverted**”, 08:06). Again: newest-of-
  session wins, the explicit intent signal loses.

The pattern is structural: a work session on a file typically emits
root-cause → fix → verification observations; “verification” is always newest
and always the least informative. Recency-based session-dedup therefore
systematically masks exactly the killer class.

**Resolution (owner-verified 2026-07-11 by replaying `deduplicateObservations`
on live pre-dedup by-file output):** replace session-dedup with
**content-dedup (normalized-title key)**, keep cap 15, do NOT add
type-priority. Verified to surface #25165, #25175 and #24717.

Two of this report's original suggestions were **falsified by that simulation
and are withdrawn**: (a) type-priority regresses Gallery — #24717 is
`type=change`, the lowest priority, so type-ranking re-buries it under
higher-type siblings; (b) a 5–7 cap drops both killers — they need ~15 of
headroom.

Standing caveat from the owner: #24717 survives near the cap edge — its only
signal is semantic (“Reverted”); robustly surfacing that class needs a
positive content-signal (revert/intent boost), and any Bug-4 chronicle trim
must be content-based — never a lower cap or a `type=change` filter, both drop
#24717. Decision: ship content-dedup as-is; defer the intent boost until the
16-file re-run shows killer-class lines still drowning (no speculative
ranking machinery).

Re-run order once content-dedup deploys: the two killer smoke-reads first
(1 minute, lead session), then the full 16-file qualitative pass.
