# The first run

The branch of `SKILL.md` that runs once. Everything here is work no later run repeats: the pass
over the store's whole history, deriving the vocabulary file, and building the baseline the
series is measured against. Later runs read the cursor and stop.

## Cover the whole store, not the prompt window

**On the first run the cursor does not exist, and a first run covers the whole store.** Start
the prompt window wherever your own baseline recount ended and read forward — but the prompts
are not the store. Everything before that window is history no lane has ever classified, and a
first run that leaves it unread hands the next run a backlog nobody recorded.

Read that history through `session_summaries`, not through prompts. One summary row is a
compact record of a session — what was asked, what was investigated, what was learned, what was
completed, what came next — and it exists for sessions that produced no spec, no branch and no
artefact, which is exactly the work a prompt window misses. Full text for every historical
prompt is what is unaffordable; the summaries are not. Slice them and fan out: the
`weekly-digests` skill in this same plugin already implements the shape — split the timeline
into per-period slices, one subagent per slice, each handed the previous slice's carry-forward.
**Take that mechanism; do not take its output.** A period-by-period narrative is the deliverable
that file exists to argue against — the carry-forward here holds open findings and counts, not
continuity of story.

This pass is also where a stored conclusion gets re-checked and, where it is wrong, retracted in
place: see the retraction rules in `SKILL.md`, which apply to every run but reach every row only
on this one.

## Build the vocabulary file

**No vocabulary file means this is a first run for this user — build it.** Read the window,
derive the categories by the fix test in `SKILL.md`, and collect the phrasings this user actually
reaches for. Write `~/.claude-mem/state/harness-review-vocab.md`: categories with one-sentence
definitions, any closed lists, the priority order, `Version: v1`. Say in the report that this run
built the vocabulary rather than applying one, so its counts are the first point of a series and
not a comparison.

**A worked first run is in `first-run-example.md`, beside this file** — invented person, invented
numbers, categories deliberately unlike anyone's real ones. Read it for the shape of the thing,
never for its content: a run whose derived categories resemble that file's has copied rather than
read.

## Build the baseline, recompute once, then freeze

**A baseline belongs to whoever produced it and travels to nobody.** It records how one person
works: what they let slide, how they phrase a complaint, how tool-heavy their tasks are. The
skill therefore ships no baseline numbers at all — an earlier version did, and every reader who
was not that person had a table that looked authoritative and meant nothing. Your first runs are
your baseline; until you have several, the honest report is "establishing a baseline", not "the
rate moved". Keep the table in `~/.claude-mem/state/harness-review-series.md`, beside the series.

Recompute **once**, against a written rubric, keeping the prompt ids behind every count; publish
it with a ledger row; then freeze it. Freezing an unverified number does not make it true, it
makes the error canonical — and a number no one can trace to rows cannot be checked later by
anyone, including you.

**A recompute by one labeller is not a baseline, and the check that matters is on the boring
bucket.** Agreement on the *corrections* runs high and its disagreements are one step of
severity — reassuring, and not where the error is. The error is in the neutral bucket, where a
blind sample finds corrections the first pass missed, unevenly across periods. That distorts the
shape of the series, which is the only thing a series is read for. So before freezing: have a
second labeller relabel the neutral bucket blind, writing its labels before it opens the first
pass's file. If the miss rate is material, re-pass the whole bucket — an extrapolation from a
small sample is not a baseline either, and a full pass has been measured landing far from what
its sample predicted.
