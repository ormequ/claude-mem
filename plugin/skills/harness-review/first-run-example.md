# A first run, worked through

**Everything here is invented.** The person, the categories, the numbers, the proposals. It
exists to show the *shape* of a first run — how categories get derived, what the vocabulary file
ends up looking like, what the report contains. **Do not copy the categories.** They belong to a
fictional person whose failures are not yours; the whole point of the method is that yours come
out different.

If your derived categories look like the ones below, you have copied instead of read.

---

## The situation

A solo developer maintaining a Python data pipeline. Three weeks of capture, one project, no
prior review. `~/.claude-mem/state/` is empty: no ledger, no vocabulary, no cursor, no series.

## Step 0 — ledger

Nothing to score. The run creates `harness-ledger.md` with a header and one row for the only
harness change it can find evidence of, then says in the report: *this run established the
ledger; there were no open predictions to score.*

**Open loops.** None yet — the file does not exist, and this run creates it. Two prompts in the
window turn out to be harness-directed: *"the linter should run before you say it's done"* and
*"why do I keep having to tell you which profile to use"*. Neither was ever acted on; both go in
as `open`, with their prompt ids. The second one turns out to describe the same defect as the
run's own top proposal — the owner had diagnosed it weeks earlier, in one sentence, and nothing
picked it up.

## Step 1 — liveness

Newest prompt and newest observation are both from today, and the daily ratio is flat across the
period. No outage, no fade. One line in the report; move on.

## Step 2 — deriving categories from scratch

No vocabulary file exists, so this run builds one. It reads all 260 prompts in full, and for
every prompt that looks like the user repairing something, asks the only question that matters:
**what single change would have prevented this?** Prompts that would be closed by the same
change become one category.

What fell out, after reading:

| Derived category | The fix that would prevent it | Count |
|---|---|---:|
| assumed a table's columns without reading the schema | make the schema file a required read before writing a query | 14 |
| ran against the production profile | change the default profile in the config, deny the prod one | 6 |
| edited files outside the requested scope | a prohibition plus a diff check before claiming done | 9 |

Three categories, because three distinct fixes. Note what did **not** become a category: "the
agent was sloppy" — no fix corresponds to it, so it is a mood, not a category. Its members went
into the three real ones.

**Priority order falls out of the fix test.** One prompt read *"you rewrote the whole file again,
and against prod"* — two categories at once. Primary is the production one: that fix would have
prevented the incident that mattered. Scope becomes a tag.

**A fourth bucket.** This person pastes raw tracebacks as entire prompts, constantly — 31 of 260.
Not corrections: the agent did nothing wrong, the pipeline failed. Not instructions either. They
get their own primary bucket, named `traceback dumps` in the vocabulary. Folded into `neutral`
they would have been the largest thing in the bucket; counted as corrections they would have
doubled the rate.

**Severity, by consequence.** One S1: a command run against the production profile deleted a
staging table — irreversible and visible outside the session. Four S2 (wrong work: scope). The
rest S3.

**Harness-fixable or not.** Of the 29 corrections, 23 name a change that would have prevented
them. The other 6 do not: the user reconsidered a design after seeing it drafted. Reported
separately — the harness-attributable rate is 8.8%, and the remaining 2.3% is the floor.

**Labels sum:** 260 = 29 corrections + 31 traceback dumps + 12 excluded + 188 neutral. If they
had not summed, the period would be reported as an invalid instrument, not as a clean one.

**The set, read as a set.** Two things no single prompt showed. The word "local" had to be
repeated in eleven separate sessions before running anything — a rule living only in the
owner's head. And every request in the last week opens with "check the schema first", a
preamble that appeared right after the schema category peaked: the defect is being carried by
the user, and the category's decline that week is not improvement. Both were put to the owner in
his own words; he confirmed the first and rejected the second as "that's just how I write now".

## Step 3 — false positives

Applying the test *would this prompt exist if the agent had behaved perfectly?*:

- **12 prompts** are the same message re-sent within a minute with a file path appended. The
  person sends before finishing the thought. Not the agent's doing → excluded. Mechanical rule
  written into the vocabulary: *same session, within 60s, later text contains the earlier one*.
- A blind sample of 35 neutral rows, relabelled cold, turned up 2 corrections the first pass had
  missed. Reported as a ~6% miss rate beside the correction rate, not folded into it.
- One rule could not be applied: separating "one message sent to three agents at once" needs a
  session id the search result does not carry. **Reported as not computable**, not silently
  skipped.

## Step 4 — the lanes

- **Lane B, re-derived facts.** Two stable clusters survive the volatile/stable read: the
  location of the connection settings, re-established in 5 of 22 sessions; and which of two
  scripts owns the nightly load, in 4 of 22. Neither is documented anywhere — checked before
  proposing.
- **Lane C, worked-around errors.** One signature dominates: a credentials helper prompting for
  input in a non-interactive shell, 40 hits across 11 sessions, span reaching today, zero
  prompts complaining about it.
- **Lane D, compliance.** The instruction file states one file-shaped prohibition. It was
  violated in 3 of 22 sessions in the window.
- **Lane E, task outcomes.** No registry exists. Reported as **not measured**.

## The report this run produces

> **Open loops.** 2, both raised by the owner and never shipped, ages 3 and 5 weeks. One of
> them is the same defect as proposal 1 below.
>
> **Ledger.** Established this run; no open rows to score.
>
> **Lanes.** Prompts: ran. Re-derived facts: ran. Worked-around errors: ran. Compliance: ran.
> Task outcomes: not measured, no registry exists.
>
> **Instrument.** Vocabulary built this run, `v1` — these counts are the first point of a
> series, not a comparison. Three of four subtraction rules computable.
>
> **Numbers.** 260 prompts, 29 corrections (11.2%), 31 traceback dumps (not corrections),
> 12 excluded. Severity: S1 1, S2 4, S3 24.
>
> **Proposals.**
> 1. Deny the production profile in the runner config and default to local. *Cites: 6 prompts;
>    the S1 incident; the config file that currently defaults to prod.*
> 2. Set the credentials helper to non-interactive in the environment. *Cites: 40 failed calls
>    across 11 sessions, span open, and no prompt mentioning it — the prompt lane is blind here,
>    so the correction rate above cannot be read as evidence of health.*
> 3. Write the connection-settings location into the instruction file. *Cites: 2 clusters,
>    5 of 22 and 4 of 22 sessions; grepped, currently undocumented.*
>
> **Ledger rows opened** for each of the three, with what must move and by when.
>
> **State audit.** ledger ✓ written 2.4K · open loops ✓ written 0.9K · series ✓ written 0.5K ·
> vocabulary ✓ written 1.3K · cursor ✓ advanced 0.1K · evidence file ✓ written 3.1K ·
> clusters ✓ written 0.7K (on probation).
>
> **Owner's verdict on the findings:** production profile — *did not know*; credentials helper —
> *did not know*; connection settings — *knew*.

## What the run leaves behind

- `harness-ledger.md` — three new rows with predictions.
- `harness-open-loops.md` — two rows, both `open`, from prompts the owner had already written.
- `harness-review-vocab.md` — the three categories with one-sentence definitions, the fourth
  bucket, the subtraction rules, the severity anchors, `Version: v1`.
- `harness-review-series.md` — one row: the window, the counts, the lane headlines.
- `harness-review.json` — the cursor, in UTC, carrying the window's ceiling as `last_prompt_id`,
  which is the whole record the next run needs to check the seam.
- the local evidence file — the run's own numbers, kept out of the shipped skill.
- `harness-clusters.md` — the two clusters and what was decided about each, plus the condition
  under which the file itself goes.

Next run scores those three predictions **before** looking at anything new.
