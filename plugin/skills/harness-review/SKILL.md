---
name: harness-review
version: 2.5.0
description: Measures whether the harness is getting better, across several lanes - the user's corrective prompts, facts the agent keeps re-deriving, and errors it silently worked around. Use when asked for a harness retrospective, a correction-rate check, "is the harness getting better", "did that fix help", "what keeps going wrong", or a periodic review of how the agent has been failing the user.
allowed-tools:
  - Bash
  - Read
  - Write
  - mcp__plugin_claude-mem_mcp-search__search
  - mcp__plugin_claude-mem_mcp-search__timeline
  - mcp__plugin_claude-mem_mcp-search__get_observations
  - mcp__plugin_claude-mem_mcp-search__get_prompts
---

# harness-review

**A retrospective that produces no number produces no improvement.** Months of them can feel
productive and change nothing measurable, because nothing was counted. Count first, read second,
and propose only things a machine can enforce.

**Several lanes, because no single one is trustworthy.** The user's prompts are the only signal
generated outside the system being measured — and they only exist where a failure was annoying
enough to type about, which is a small and shrinking part of what goes wrong. Steps 1–3 read
that lane. Step 4 reads what the agent did rather than what the user said, and a review that
runs only the prompt lane is one lane of one.

Read through the `search` / `timeline` / `get_observations` / `get_prompts` MCP tools. Four
queries go straight to the database because `search` caps at 100 results and cannot group —
the daily ratio in Step 1 and one per lane in Step 4. Each is marked where it appears.

**All `search` / `timeline` queries must be in English.** The store uses an English-only
embedding model — a non-English query returns confident but unrelated results. Keep
identifiers (file paths, service names, error strings) verbatim; translate only the prose.

**Nothing measured on one machine belongs in this file.** Counts, dates, week numbers, project
names, provider strings, a stack's file patterns — all of it is one person's setup, and shipped
here it reads as a norm to everyone else. This file carries rules and shapes; the evidence
behind them lives beside the other state, in `~/.claude-mem/state/harness-review-evidence.md`,
which stays local.

## When to use

- A periodic review of how the harness has been failing (fortnightly or monthly).
- After a harness change landed: did the correction rate move?
- The user asks what keeps going wrong, or why the same failure repeats.

**Do not use** for reviewing a single session, debugging one failure, or auditing code quality.
Every lane here is a comparison across time; one session has no baseline.

**No cursor, no vocabulary file, no series? That is a first run — read `first-run.md` beside this
file before Step 2 and do what it says.** It holds the work a first run does and no later run
repeats: the pass over the whole store through `session_summaries`, deriving the vocabulary file
from this user's own prompts, and building the baseline every later number is compared against.
A first run that skips it reports counts with nothing to compare them to and hands the next run a
backlog nobody recorded.

**Works without any corrective prompts at all.** If the user only assigns tasks and never
corrects — an autonomous run, a fresh setup — Steps 1–3 return near zero and Step 4 carries the
review. Read Lane E before reporting anything in that mode.

## Step 0 — score the ledger. A run that skips this is void

**If the ledger file does not exist, create it and say the run established it.** A first run
has nothing to score and is not void for that reason — it is void only if a ledger exists and
was skipped. Seed it with any harness change already shipped that you can state a prediction
for; an empty ledger with a header is better than none, because the next run inherits the
discipline rather than reinventing it.

`~/.claude-mem/state/harness-ledger.md` holds every shipped harness change alongside the
number it predicted would move. **Read it before anything else, and report open rows before
any other number.** A review that finds new things without checking whether the last fix
worked is the exact failure this skill exists to prevent.

Score each open row: `moved` / `not moved` / `verified` / `unexposed` / `regressed` /
`inconclusive` / `needs its own pass`.

**Collapse a row once it has proven itself.** A row scored `verified` whose signature has not
returned for two consecutive runs has done its work; its remaining value is one sentence — do not
propose this again — so collapse it to a single line that still carries its evidence inline:

```
2 · fd installed <date> · verified · was N failures across M sessions; zero in two runs since
```

Self-sufficient without the store, and enough to find the detail there if anyone wants it. Killed
proposals are already one-liners; leave them alone.

### The other half of the ledger: what the user asked for and nobody shipped

**The ledger above tracks fixes that shipped. Nothing tracks fixes the user proposed.** A
harness problem the owner identified out loud, which then dropped because the conversation moved
on, is invisible to every lane in this file: it produced no error, no correction, no re-derived
fact — the work never happened, so there is nothing to measure.

Keep them in `~/.claude-mem/state/harness-open-loops.md`, one row each: the prompt id and date,
what was asked for in one line, and a status — `open` / `shipped` / `declined`. Populate it from
the harness-tagged prompts in each window.

**Print the open loops first, before the ledger scores and before any other number.** They are
the cheapest work available: the diagnosis is done and the owner has already said what they
want.

- **A loop closes only two ways: it ships, or the owner declines it in as many words.** Silence
  is not a decline — silence is exactly how it was lost the first time.
- **Carry the age.** A loop still open at its third run is itself a finding, and not a
  scheduling one: it means the mechanism loses what the owner already found, which is worse
  than any single defect it might have fixed.
- A `declined` row keeps the date it was declined and stops being shown.
- **A shipped loop is a ledger row, not a loop.** On `shipped`, move it to the ledger and remove
  it from this file; keeping it in both is duplication that every later run reads. `declined`
  collapses to one line carrying its date. `open` and `agreed` are the only states that occupy
  space here.

`needs its own pass` is for rows this skill cannot check with the tools it is allowed —
a fix whose verification needs a hook triggered by hand, or queries the owner has to score by
eye. **It is a legitimate outcome and must name what the check requires**, in one line, so the
next run inherits the answer instead of improvising one. Without it a run either invents a
score or drops the row quietly, and a dropped row is invisible in exactly the way this ledger
exists to prevent.

- `verified` is for deterministic fixes. Not every fix moves a number; some just correct code,
  and forcing them to carry a longitudinal metric manufactures a fake one.
- `unexposed` means the mechanism never had an opportunity to fire. **Never record that as
  `not moved`** — a rule that was never triggered has not failed.
- A due condition that is a date alone is under-specified. An outage silently eats the sample
  and the result then reads as "the fix did not help". Due is *N eligible events or the date,
  whichever is later.*
- Fixes shipped together on one day cannot be scored separately against a shared metric. Score
  them as one bundle and say so.

## Step 1 — is the store alive? Stop here if it is not

```
search(type="prompts",      dateStart="<30 days ago>", limit=1, orderBy="date_desc")
search(type="observations", dateStart="<30 days ago>", limit=1, orderBy="date_desc")
```

**`dateStart` is required.** A filterless `search(type="prompts", limit=1)` is rejected with
`INVALID_SEARCH_REQUEST` — this skill shipped with that call and it never once ran.

Prompts are written by a hook; observations need the generator to reach a model. So **prompts
keep flowing while observations stop**, and the gap between those two timestamps is the outage
signal.

**If they differ by more than a day: report that as the finding and stop.** Every number below
would describe a store that is no longer being written, and a total row count looks identical
whether the store is healthy or dead.

Three ways that comparison passes on a dead store. Close all three:

- **Both sides died together.** If the prompt hook and the generator stop at the same moment
  the two timestamps stay close and the gap reads zero. Compare the newer of them against the
  **wall clock** as well: a newest prompt older than a day, on a day you worked, means capture
  is down — not that you were idle.
- **One live project masks the rest.** The store spans many projects and a single active one
  keeps the global timestamps fresh. Run the comparison per project.
- **A partial loss looks whole.** One fresh observation says nothing about the sessions that
  produced none.

**The generator's log says why, and it costs nothing.** The store can only tell you writing
stopped; `~/.claude-mem/logs/claude-mem-YYYY-MM-DD.log` tells you what failed. On a measured
outage the log's error lines described it far more precisely than any query could. Count them
per day alongside the ratio below:

```bash
grep -c "Generator failed" ~/.claude-mem/logs/claude-mem-$(date +%F).log
```

**Find the failure wording in your own log before trusting a zero.** Each provider path logs
its own phrasing, so a grep written for one setup returns zero on another and the zero reads as
health. Check the log has content, read one real failure, then count that.

This is the denominator for every observation-side number in the report. Without it, "no
findings that day" and "the generator was down that day" are indistinguishable.

A timestamp comparison catches a stop but not a **fade**. A store writing a tenth of what it
should still passes the check above.

**First of the four direct queries** — the daily ratio needs true counts, and `search` caps at
100 results per call, which silently understates exactly the healthy days:

**Group it by project.** A blended number reads as one project degrading when a dominant project
is winding down while another starts up — a fade that is not there, hiding a smaller one that
is. `search` cannot answer "latest activity per project" in one call, so this query carries the
split rather than a second one being improvised each run.

```bash
sqlite3 ~/.claude-mem/claude-mem.db "
SELECT d, proj, p AS prompts, coalesce(o,0) AS observations, round(coalesce(o,0)*1.0/p, 1) AS per_prompt
FROM (SELECT date(up.created_at_epoch/1000,'unixepoch','localtime') d, s.project proj, count(*) p
      FROM user_prompts up JOIN sdk_sessions s ON s.id = up.session_db_id
      GROUP BY d, proj)
LEFT JOIN (SELECT date(created_at_epoch/1000,'unixepoch','localtime') d2, project p2, count(*) o
           FROM observations GROUP BY d2, p2) ON d = d2 AND proj = p2
WHERE d >= date('now','-14 days') AND p >= 5 ORDER BY d, p DESC;"
```

Read each project's own series. A project falling to zero prompts is you working elsewhere; a
project holding its prompt volume while its ratio falls is the store failing that project.
Only those two readings justify different actions, and the blended number cannot tell them
apart.

Read the shape, not the value — `per_prompt` varies with how tool-heavy the work is, so no
absolute number is healthy or unhealthy. Two rules, so that two runs reach the same verdict
instead of two impressions:

- **Falling on three or more consecutive active days → report it as a finding**, and mark every
  observation-side count for the period *understated*. Say the denominators are unreliable and
  move on.
- **Days with fewer than five prompts are idle, not sick.** Exclude them rather than counting
  them as a dip.

### Check the instrument before trusting the lane

This lane has already degraded silently once. Pull three prompts and assert: `get_prompts`
returns text longer than the search index showed, `session_id` present, timestamps carrying
seconds.

Each failure is a **loud line in the report** — never a silent best effort.

Two of the four false-positive rules below (same session within ~60s; one text across many
sessions within a minute) need a session id and second-resolution timestamps on the search
result. Where the tools do not supply them, those rules are uncomputable and any category that
depends on ordering within a session cannot be verified. **Every report states which rules were in force** — a run under three of four is
not comparable with a run under four.

## Step 2 — read the new prompts and classify them yourself

Read the prompts written since the last run:

```
search(type="prompts", dateStart="<last_run UTC>", limit=100, orderBy="date_asc")
```

Page with `offset` until exhausted; a fortnight usually takes a couple of calls. Keep
`{"last_run": "<UTC, Z suffix>", "last_prompt_id": N}` in
`~/.claude-mem/state/harness-review.json`.

**Fix the window before reading it.** Note the highest prompt id present at the start of the run
and treat it as the ceiling; everything at or below `last_prompt_id`, or above the ceiling, is
out of scope. The ceiling becomes `last_prompt_id` in the cursor when the report is written —
that is the whole record the next run needs. **Do not write a per-run window file**; the range
it held is two numbers that already live in the cursor.

**Then check the seam.** The first id of this window must be `last_prompt_id + 1`. A gap means
the cursor moved further than the last run actually
read, and those prompts will never be looked at by anything: the next run starts from the
cursor, not from what was covered. `dateStart` is inclusive, so a date-only window recounts
whatever sat on the boundary, and paging by date while new rows arrive shifts pages underneath
you.

**First, drop what the user did not type.** The prompt table is written by a hook, and on a
multi-agent setup it also collects machine traffic: subagent reports relayed back to the
orchestrator, cross-session messages, internal markers. They open with a recognisable envelope —
`<agent-message from=`, `<cross-session-message`, an HTML comment marker — and they are not
false positives to be subtracted later. They are **not prompts at all**, and they must leave the
window before anything is labelled, or every rate in this lane is computed over a denominator
that is partly machine.

Count them and report the number separately: it says how much of the table is not the user, and
it grows with parallel work. **If it is more than a rounding error, the fix belongs in the
capture hook, not in this skill** — a review that quietly filters them each run leaves every
other consumer of that table reading them as the user's words.

**Every prompt in the window gets exactly one primary label** — and the four must sum to the
size of the window:

- **correction** — the user is repairing something the agent did or failed to do.
- **excluded** — a false positive under Step 3. It looks like a correction and is not.
- **neutral** — everything else. Instructions, questions, answers, approvals.
- **a fourth bucket, if this user has one.** Watch for a class of prompt that is neither a
  correction nor an ordinary instruction and that recurs constantly — the kind of thing a person
  types dozens of times a week without thinking of it as feedback at all. Give it its own primary
  bucket and name it in the vocabulary file. Folding such a class into `neutral` merges the
  largest thing in the dataset with approvals; counting it as a correction inflates the headline
  by more than every real category combined. Both have happened. Which class it is differs
  completely between people, so this file names none.

The distinction that matters is excluded-versus-neutral: an excluded prompt was a candidate that
got ruled out and should be reported as such, a neutral one never was. Anything else a prompt
also is becomes a tag, not a second primary. A window whose labels do not sum to its size is not
a clean period, it is an invalid instrument, and the period is reported as such.

**`last_run` is UTC.** Writing local time with a `Z` suffix pushes the next window into the
future, which returns zero prompts and reports a clean period.

**Guard: if Step 1 said the store is live and this window returns zero prompts, that is a
contradiction, not a clean period.** Suspect the cursor and stop.

Advance the cursor only after the report is written. A run that dies mid-way must re-read its
window, not skip it.

**Write this run's numbers to `~/.claude-mem/state/harness-review-series.md`** — and write them
as **one table row, never a report**: window id range · rows in window · the four primary counts
· harness-attributable vs floor · the S1/S2/S3 vector · rubric version · Lane C method version ·
one short headline per lane. Nothing else. A lane whose numbers live only in the report dies
with the chat, and the next run then has nothing to compare against except a frozen baseline —
never against the run before it, which is exactly what "count first" was supposed to produce.
A run that writes a table row produces a line; one measured run wrote a report instead. Every
later run must read this file before it starts work, so whatever is written here is paid for on
every invocation, for ever.

**A run's narrative belongs nowhere on disk, and no run builds per-run files or archives.** The
review session is itself captured by claude-mem, and a measured run's own conclusions do reach
`observations` — so duplicating that narrative into a file produces a reader who does not exist.
But the store is not a *reliable* archive either: the generator can fail against a provider for a
whole day, and a run on such a day leaves nothing behind. Hence the rule both halves point at —
**every surviving line carries its own number inline; a pointer to the store is a convenience,
never the mechanism.** A `runs/` or `archive/` directory was proposed and rejected.

### A stored conclusion is a hypothesis, and the run that disproves one retracts it in place

**A stored claim about the store's or the harness's own behaviour is a hypothesis, not
evidence — re-check it against the store before citing it.** The summaries this pass mines were
written by sessions that were frequently mid-way through changing the very thing they describe,
so a claim that was true the morning it was written can be false by the time a review quotes it
back — now with a second timestamp on it, which reads as confirmation rather than as a copy.

**Narrow on purpose.** Schema, counts, queries and generator behaviour are cheap to re-run, and
those are the claims this covers. What a session was trying to do, or why, cannot be re-checked
at any sensible cost: that is testimony, cite it as testimony.

**A claim the check disproves is retracted in place, by the run that disproved it.** The run
holding the disproof is the only one that will ever hold it, and a finding filed only in a report
leaves the wrong text sitting in the store, still reading as knowledge. Nothing in the store will
catch it later: there is no contradiction check and no expiry, so this review is the detector —
over everything on a first run, and over its window on every run after, which means anything
outside a later window keeps whatever it claimed.

The format is required, not advice:

- **Marker first, at the head of the field.** Search truncates, and a leading marker is the only
  form that survives into a listing — a retraction further down is invisible to exactly the reads
  that would otherwise re-cite the claim.
- **The marker names what disproved it: the commit, the query, or the file.** Without that, the
  next run cannot tell a verified retraction from someone's opinion, and pays to re-check the
  whole thing from scratch.
- **The original text stays verbatim below the marker**, never rewritten and never deleted. The
  claim and the reason it was wrong have to be readable together; an edited field destroys the
  evidence that the claim was ever made, which is the part a later run needs to see.
- **Name what is being retracted when the field holds more than one claim**, and leave the rest
  alone. A blanket marker over a mixed field discards claims nobody disproved.
- **The report cites the retraction as a finding**, with the same citation as any other.

**This format lives here rather than in a state file.** There may be no edit path for the record
being corrected — a retraction can be hand-written SQL against the store — and a format that
lives beside one run's notes is a format the next run does not have.

**Any boundary carries its reason in the cursor, written by the run that set it.** Not a note
added afterwards, and never a reason reconstructed later from the choice itself: an
after-the-fact justification cannot be told apart from a rationalisation, by the next run or by
anyone. If a run cannot cover something, the cursor records what was left out and why, as
numbers the next run can act on rather than a sentence it has to trust.

**Three sources sit in the plugin that no lane here reads.** Named because a run that never
opens them cannot say what it did not look at:

- `session_summaries` — the medium of the first-run pass (`first-run.md`), unread by every other
  lane.
- `session_start_context` — renders exactly what the SessionStart hook injects for a project.
  It is the only way to see which memory actually reaches a context, as opposed to which memory
  exists. Use it when a Lane B cluster claims a fact was re-derived that the store already held.
- the `knowledge-agent` corpus tools — semantic questions across the whole history that SQL
  cannot express. **Leads, never counts:** anything they surface is a candidate for a dig, and a
  number that came out of them does not go in the report.

**Search truncates the prompt. Fetch the full text before classifying:**

```
get_prompts(ids=[...])   → full prompt_text for every id in the window
```

Classifying on a truncated head is guessing: heads have read as questions where the full text
was a correction. If the full text is unavailable, every label in the window is provisional and
the report says so.

## The categories are yours to derive, and this file deliberately names none

**A category list is a description of how one person is failed by one harness.** Someone else's
list will differ completely — different work, different tolerances, different words, often a
different language. Copying a list produces counts that balance and mean nothing, and it hides
the categories you actually have, because a reader who has been handed four boxes puts
everything in one of the four.

What travels is the method.

**Group corrections by the fix that would have prevented them, not by wording and not by how
they feel.** A category earns its place only if every prompt in it would be closed by the same
mechanism — one hook, one prohibition, one config line, one change to an instruction file. That
test does three jobs at once: it keeps categories mutually exclusive, it makes the priority
order fall out instead of being declared arbitrarily (when a prompt fits two, the primary is the
one whose fix would have prevented it), and it guarantees every category can produce a proposal
under the output contract. A category no fix corresponds to is an observation about a mood.

**Declare the order before counting, whatever it is.** Categories overlap — one sentence can
easily be three things at once — and without a fixed order each run resolves the overlap
differently, which is fatal for a number whose only job is comparison across time.

**The lane's subject is not only failure.** A prompt saying the result should have been
shorter, or simpler, or that a step was ceremony — where nothing broke and the work was
delivered — is a signal about the harness's *shape*, and under a failure-shaped rubric it falls
straight into `neutral` and is never read again. It belongs in its own bucket: outside the
correction rate, because nothing failed, and inside the proposals, because the user has just
told you what to change.

**This is also how the harness knows what to trim.** There is no absolute standard for how long
a document should be or how many steps a process needs — that depends on the machine, the work
and the person. The standard is the user's own dissatisfaction: complained about repeatedly,
it is too long; never mentioned, it is fine. A review that measures artefact size against a
number of its own invention is measuring its own opinion.

**Tag every prompt whose subject is the harness itself.** Not the task — the tooling: the
instruction files, hooks, settings, permissions, the sandbox, a skill, or the agent's working
method treated as policy rather than as this task's problem. These are usually not corrections
at all. "We should fix X", "this rule is wrong", "why is this still manual" — a proposal, not a
complaint, and it lands in `neutral` where nothing ever reads it again.

**Including — especially — a rule stated in passing.** The most easily lost form is not a
request at all: a general policy attached to a specific instruction. *"Agent docs are English
only — send this one to be translated."* The user is not asking for a harness change; they are
announcing a standing rule and expecting it to hold from now on. It will not, because nothing
wrote it down, and the next session has never heard of it.

The tell is a general clause riding along with a particular task: *only*, *always*, *never*,
*from now on*, *we do it this way here*. The proposal that follows is the same every time and
needs no thought — put it in the instruction file, verbatim enough to be checkable. These are
the cheapest wins available and the ones a failure-shaped rubric never sees, because nothing
went wrong: the user just told you the rules and moved on.

**This is the most valuable prompt in the corpus and the easiest one to lose.** The user has
already done the diagnosis, for free, and named the fix. If the conversation then moved on — and
it usually does, because the person was in the middle of something else — the whole thing
evaporates. It leaves no trace anywhere else: no tool error, no re-derived fact, no correction,
nothing for any other lane to find. A run that scores the ledger and never asks what the user
proposed and nobody shipped is measuring only the fixes that happened to get attention.

**Tag `harness-doubt` when the user questions a harness component itself.** Not *is this claim
right* — that is the claim-challenge below, and its answer lives in the agent's reply. This one is
*is this thing worth having*: does that skill do anything, why is this hook still here, is this
rule earning its injection. They arrive one at a time, each individually minor, and each scores as
the lowest severity there is. **Report rule: enumerate every tagged id and name the component each
one is about; never fold them into a severity count.** The aggregate — several prompts doubting
one component across a period — is the finding, and a severity column destroys it. Carry
the tag in the vocabulary file so the next run applies it without rediscovering it.

**Sample the neutral bucket, every run, not only when building a baseline.** Everything labelled
neutral is never read again, so a correction mislabelled neutral disappears permanently and
silently — no sum fails, no guard fires. Once the window is labelled, take thirty to forty
neutral rows by a fixed rule (every Nth, so the choice is not yours) and relabel them cold.
Report the miss rate next to the correction rate — **including when it is zero**. A clean sample
is a real result about the instrument, and it is exactly the kind of boring number a run drops
for lack of anything to say about it. The misses hiding there have moved a headline further than
any shipped fix, and nothing else in an ordinary run surfaces them.

**Classify by reading, not by keyword matching.** A baseline run that searched for correction
words missed an entire category, because the word its owner actually used was not on the list.
Any keyword list is a guess at a vocabulary the user extends without telling you.

**When the prompt challenges a claim, open the reply before scoring it.** *"Where did you get
that?"*, *"did you actually look?"* — the prompt records only that the user doubted. **Whether
the doubt was founded lives in the agent's answer**, and the answer often names a real source
the user had not seen, or turns out to be about a different file, or shows the user's own
environment was confused. Find the session transcript, read the assistant turn that follows,
and score from that. If the transcript cannot be found, leave the row **unscored** and say so —
do not fall back to the prompt alone. This is procedure, not judgement, and it is the largest
labelling defect measured so far: correction rows withdraw in numbers once the replies are read,
and most of the withdrawals are claim-challenges.

**Separate three things that arrive in the same shape**, or a design-heavy period reads as a
harness collapse: the user correcting the **agent**; the user revising an **artefact** the agent
is drafting for them; the user reasoning about the **system under study**. All three sound like
"no, X, not Y". Only the first is a harness failure.

**The wordings and the category list live outside this file**, in
`~/.claude-mem/state/harness-review-vocab.md` — they are one person's prompts, and this skill is
meant to be shared. Read it before classifying; any closed list in it is closed, and a run that
widens one has changed the instrument and must say so.

**Things that are not prompts cannot be counted from this lane.** An interrupt, a cancelled
call, a session abandoned mid-task — these are harness events, and they leave no row here.
Report them as *not measured*. A silent zero is indistinguishable from "there were none", and
reads as the healthier of the two.

### Then step back: what do the prompts say as a set?

Everything above reads one prompt at a time, and one prompt at a time is the wrong altitude for
the most useful question this lane can answer: **taken together, what rule would have made most
of this unnecessary?** A per-row finding is rarely news to the person who typed the row — they
were there. The set is not: nobody sees their own last two hundred prompts at once.

Ask it deliberately, after classifying and before writing proposals, over this window and the
previous ones in the series:

- **What did you have to say more than once?** The same instruction re-issued across sessions
  is a rule that exists in the user's head and nowhere else. Each instance looks like an
  ordinary instruction; only the repetition makes it a finding, and no single window shows it —
  this is the one question that requires looking across windows rather than within one.
- **Where in the work do the corrections cluster?** If they concentrate in one phase — planning,
  review, hand-off — the defect belongs to that phase, and a rule scoped to it beats a general
  one about care.
- **What never has to be said here?** The rules already working. Worth knowing before anyone
  proposes deleting one for looking inert.

**A rule derived this way is a claim about what the user wants, so put it to them in their own
words and let them correct it.** Deriving preferences from behaviour and then enforcing them
unasked is how a harness acquires rules nobody agreed to.

Two tests before any of it becomes a proposal, both cheap and both routinely skipped:

- **Grep first.** If the rule is already written somewhere in force, the finding is not "write
  this down" — it is that a written rule is not being followed, which is a different and more
  serious proposal.
- **Replay it.** Name the cited prompts and ask whether this rule, in force at the time, would
  actually have prevented them. A rule that survives this reads like a rule; one that does not
  reads like "be more careful" with extra words.

### Second label: could a harness change have prevented it?

**Not every correction is the harness's fault, and a rate that mixes the two has a floor it can
never cross.** The user changing their mind, a brief that was half-formed when it was sent, a
decision that could only be made after seeing the work — these produce corrections no
instruction file, hook or config would have prevented. Counted together with the rest, they set
a floor under the correction rate, and every run below that floor reads as failure to improve.

The test is written and binary, applied while reading: **name the change that would have
prevented this prompt.** A hook, a prohibition, a config value, a line in an instruction file, a
tool that should exist. If nothing can be named, the correction is not harness-attributable.

- Report the two counts separately, always, and never blend them into one rate.
- The harness-attributable count is the one a ledger row may predict against.
- **The other count is not noise — it is the floor**, and its size tells you how much room the
  harness has left. A period where it dominates is a period where the harness is close to as
  good as this measurement can show.
- Naming the change is also the first draft of the proposal, so this costs nothing beyond what
  the output contract already demands.

### Second label: severity

Counts alone are blind to weight. A handful of prompts about a destroyed working tree matter
more than a whole week of friction, and nothing in a count says so. Give every correction a
severity in the same reading pass, on three levels defined by consequence:

All three levels are **classes of consequence**. Do not define one of them by what the prompt
looked like — an earlier version defined the lowest level by prompt shape while the other two
described what the agent's action caused, which put two axes in one scale and made the bottom
level collide with the non-correction bucket above.

- **S1 — irreversible, or it left the session.** Work destroyed that cannot be recovered; an
  action someone outside the session saw; a claim about the state of a real system, made without
  looking, that was then acted on.
- **S2 — the wrong work got done, recoverably.** Scope invented, an instruction acted on that
  was never given, a process bypassed. The cost is the work itself and the time to undo it.
- **S3 — the right work, at avoidable cost.** It arrived, but it took a round trip that a
  working harness would not have needed.

**Write your own anchor incident under each level, in the vocabulary file, taken from what has
actually happened here.** The levels are general; the incidents are not, and a level without an
anchor drifts a step every run.

**Report the vector, never a single blended index.** One number invites optimising the number,
and a fall in S3 would hide a rise in S1. It also gives ledger predictions a shape worth having:
"zero S1 this period" means something, "the correction rate fell four percent" does not.

**Check severity calibration between labellers on identical prompts before reading a difference
as real.** Two passes reporting very different S1 counts may be using the same bar on different
periods — measured, that is exactly what happened once, and the obvious reading would have been
wrong in the direction that suppresses incidents.

### The other direction: what the user says before the failure, not after

**Every label above is retrospective.** The user says the agent got it wrong, and the lane counts
it. Nothing so far counts the opposite shape: a constraint loaded into the request *in advance*
because the user has learned that otherwise the agent will get it wrong — "and don't forget X",
"same as last time", "only don't do Y". Nothing has failed in that prompt, so its primary label
is `neutral` and stays there. What it carries is a **tag**, and the tag is evidence: the defect
is alive, and the user is now paying its cost instead of the harness.

**This is the instrument for a trap this file already names and does not measure.** The trap
table warns against reading the prompt stream as a stationary instrument — once the user learns
the agent drops something, the "you forgot X" prompt disappears while the defect does not, and
the correction rate falls for the wrong reason. Naming the trap does not detect it. Counting both
shapes side by side separates the two readings:

- Corrections fall and pre-emptive instructions fall with them — the defect is gone.
- Corrections fall while pre-emptive instructions rise — the defect survived and moved onto the
  user. That is not an improvement, and under the correction rate alone it is indistinguishable
  from one.

**Report the two counts beside each other, never merged into one.** A pre-emptive instruction is
not a correction and must not enter the correction rate: it repaired nothing, and folding it in
would penalise the user for having learned to work around the defect.

**Only count it when the constraint it carries matches a defect this review has seen elsewhere**
— a correction in an earlier window, a Lane B fact the agent keeps re-deriving, a Lane D rule
that is written and not followed. Without that match a specific instruction is just a specific
instruction: people are allowed to be precise about what they want, and reading ordinary
precision as harness failure inflates the lane with everything the user happens to spell out.

**Name the tag in the vocabulary file, not here.** What this shape is called, and which
constraints count as instances of it, is derived from one person's prompts like every other
category in this lane; this file ships the distinction and the reading it enables, and no
wording for either.

### The agent side

Corrections only mean something against the volume of work that drew them.

```
search(type="observations", obs_type="finding", dateStart="<last_run UTC>", limit=100)
search(type="observations", obs_type="failed_attempt", dateStart="<last_run UTC>", limit=100)
```

**Both types have a start date — the day the extraction prompt that introduced them shipped
here.** Before it they return zero because the type did not exist, not because nothing was
concluded. Read the date off `plugin/modes/code.json`'s version history rather than assuming
it, and never plot these two against anything earlier.

If a call returns exactly 100, the real number is "≥100"; page with `offset`.

`failed_attempt` near zero is itself suspect — agents that never record a failed approach are
not failing less, they are not writing it down.

**Do not divide these two counts by anything while a ledger row targets either of them.** If an
open row predicts that the share of one type rises — an extraction-prompt change is the usual
case — then that share moves on its own and any ratio built on it measures the experiment, not
the harness. Report the counts side by side and say which rows make them untrustworthy.

## Step 3 — subtract the false positives before calling anything a correction

**The test: a false positive is a prompt whose existence is explained by something other than
the agent's behaviour.** Typing habits, the transport, several agents addressed at once,
infrastructure output pasted in. It reads exactly like a correction to anything short of
reading it, and the class is large enough to double a correction rate by itself.

**Which classes you have depends on how you work, so derive them and write them down.** Read a
window with this question only: *would this prompt exist if the agent had behaved perfectly?* If
yes, it is not a correction, whatever it looks like. Record each class you find in the
vocabulary file with its subtraction rule stated mechanically — a time bound, a session bound, a
text relation — so that two runs subtract identically. A rule that has to be re-invented each
run is not a rule.

**State which rules were computable.** Subtraction rules need fields the tools may not return —
a session id, timestamps with seconds. A run that could apply three of its four rules is not
comparable with a run that applied four, and must say so rather than quietly reporting a lower
number.

**Ask before you subtract a whole category. A correction category is a claim about what the user
meant, and the user is available to ask** — cheaper than any amount of arithmetic, and the only
method that can tell you a category is measuring nothing its owner experiences as failure. Two
versions of this skill computed an elaborate defensible discount where one question settled it
differently.

## Step 4 — the lanes where nobody complains

**The prompt lane has a ceiling, and it is lower than it looks.** A prompt exists only when a
failure annoyed the user enough to type about it. Everything the agent wastes silently —
re-deriving the same fact for the ninth time, working around the same blocked path for two
months — costs tokens and time and produces no prompt at all. Worse, pre-emption degrades the
lane on its own, which is what the pre-emptive-instruction tag in Step 2 exists to catch.

So the prompt lane cannot be the whole review, and a falling correction rate means nothing
until a lane below agrees with it. **These lanes read what the agent did, not what the user
said about it**, which is also their weakness: the agent is the judge in its own case, and both
lanes measure only what the generator happened to write down. Every count here is a **floor**,
never a total. Say so in the report.

Both queries below hit the database directly, for the same reason Step 1 does: `search` caps at
100 results and cannot group.

### Where the harness keeps its things

**The store is the same everywhere** — claude-mem writes to `~/.claude-mem` whichever runtime it
was installed into, so Steps 0–3 and Lanes B and C need no adaptation at all. What differs is
everything file-shaped: which instruction files are in force, where permissions are configured,
and where the session transcripts live. **Resolve these by what exists on disk, and name the
files you actually used in the report.** A proposal to edit a file this runtime never reads is
worse than no proposal.

| | instructions | permissions / settings | session transcripts |
|---|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md`, project `CLAUDE.md` / `AGENTS.md` | `~/.claude/settings.json` — permissions, hooks, sandbox | `~/.claude/projects/**/*.jsonl`, errors flagged `is_error` on the tool result |
| Codex | `~/.codex/AGENTS.md`, `~/.codex/rules/`, project `AGENTS.md` | `~/.codex/config.toml`, `~/.codex/hooks.json` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, `custom_tool_call` paired with `custom_tool_call_output` |
| OpenCode | `~/.config/opencode/AGENTS.md`, project `AGENTS.md` | `~/.config/opencode/opencode.json` | not files — `~/.local/share/opencode/opencode.db`, tables `message` / `part`, plus a `permission` table that records denials directly |

Locations drift between versions. If nothing at the listed path exists, look before concluding
the runtime has no transcripts, and say in the report that the lane found none rather than
reporting zero errors.

### Lane B — facts the agent keeps re-deriving

Same fact, established from scratch, session after session. Nobody complains, so the prompt
lane is blind to it by construction.

```bash
sqlite3 ~/.claude-mem/claude-mem.db "
WITH norm AS (
  SELECT project, memory_session_id, created_at_epoch,
         trim(replace(replace(lower(title),'.',''),':','')) t
  FROM observations
  WHERE title IS NOT NULL AND trim(title) <> ''
    AND title NOT LIKE 'Task % status%' AND title NOT LIKE 'Task % completed%'
    AND title NOT LIKE 'Session continuation%'
),
cl AS (
  SELECT project, t, count(*) times, count(DISTINCT memory_session_id) sessions,
         count(DISTINCT date(created_at_epoch/1000,'unixepoch','localtime')) days,
         min(created_at_epoch) a, max(created_at_epoch) b
  FROM norm GROUP BY project, t
  HAVING sessions >= 3 AND days >= 3
)
SELECT times, sessions,
       (SELECT count(DISTINCT o.memory_session_id) FROM observations o
        WHERE o.project = cl.project AND o.created_at_epoch BETWEEN cl.a AND cl.b) exposure,
       days, date(a/1000,'unixepoch','localtime')||' → '||
             date(b/1000,'unixepoch','localtime') span,
       project, substr(t,1,52) title
FROM cl ORDER BY sessions*1.0/exposure DESC LIMIT 25;"
```

`exposure` counts the project's sessions between the cluster's first and last occurrence, taken
from `observations` — every session, not only the ones whose titles survived the filter above.
**It is still not every session the project had.** A session the generator never wrote for is
invisible here, so an outage inflates every share, and the gap grows exactly when Step 1 reports
a fade — read the two together. `sdk_sessions` looks like the right source and is not: it can
hold a fraction of the sessions `observations` knows for the same project, which puts shares
computed against it above 100%. Check that before trusting it.

The share and `sessions/exposure` is the only honest reading of how often the fact was
re-derived. Three sessions out of five and three out of five hundred are the same number in the
`sessions` column and nothing alike in reality — ranking by raw count puts the smaller, denser
cluster below the bigger, sparser one.

**The share is not a gate — but `HAVING` and `LIMIT` are, and pretending otherwise is a lie
this file told.** Nothing is dropped *for being rare in share terms*: rarity decides where the
fact goes, not whether it is worth writing. But the query never shows a cluster below three
sessions or past rank 25, so those are decided before any reading happens. Say in the report
what the cutoffs were.

For the watchlist, drop the threshold by one step and keep the extra rows in the decisions file
rather than the report — otherwise "sub-threshold clusters worth watching" asks you to record
clusters the query never returned. They earn their place because a fact sitting just under the
threshold is invisible until it silently becomes news, and the growth is the thing worth
reacting to. **Check the size before committing to this**: one step down can multiply the list
several times over, and a decisions file that grows by hundreds of rows a run is one nobody
reads. If that is what happens, record only the sub-threshold clusters that grew since the last
run.

**What the share decides is where the fact goes, not whether it is worth writing.** Places cost
differently: a line in `CLAUDE.md` is paid on every session for ever, a comment at the point in
the code where the fact keeps being re-derived costs nothing until someone arrives there, a doc
beside the code costs nothing until it is opened. Frequent and concentrated → permanent
context. Rare but stable → put it where the agent will already be standing. Too rare to justify
either → propose nothing and record that you decided so.

**Matching on the exact title is a floor and a crude one.** Two sessions that word the same
discovery differently do not cluster, and no number here can tell you how many were missed.
Report what the clusters show; never report the total as "the amount of re-derivation".

**Group by project.** The fix is a file in one repo, so a cluster spanning projects is usually
two different facts colliding on a generic title.

**Then read the titles, because most of the list is not waste.** The query cannot tell a fact
that stays true from one that was true for a minute, and the second kind *should* be
re-established every session:

- **Volatile — expected, drop it.** Branch names and SHAs, task or ticket status, session
  bootstrap, "command produced no output". Re-deriving these is correct behaviour.
- **Stable — this is the lane's subject.** Repository layout, a symlink, where a constant
  lives, how a flow is wired, which tool a repo does or does not have indexed. True last month,
  true next month, and re-derived anyway.

**Before proposing to write a stable fact down, check whether it is already written.** Grep the
instruction files in force for this runtime — the table above — and the docs beside the code. If it is there and was
still re-derived, the proposal is not "document it" — it is a defect in what gets read or
injected, and it is a much more serious finding than the cluster it came from.

**Never propose consolidating the fact back into the store.** A consolidated row outranks its
sources in retrieval by construction, so it would appear in every later measurement as a
success it did not earn, and would poison every observation-side number in this file.

**This lane cannot use the prompt cursor, and must not try.** A cluster is multi-session by
definition, and measured clusters have spanned a month, so a fortnight's window cuts them below
any threshold and the span, which is the finding, would disappear. The query runs over all
history every time; that costs nothing in context because it returns two dozen aggregate rows,
not the tens of thousands it scanned.

**What keeps the report short instead is the split.** Clusters with a hit since the previous
run are live and are the work list. Clusters that went silent go to the ledger rather than the
proposals.

**A span that ends is a candidate for "the fix worked", not proof of it.** It reads identically
when the project simply went quiet, when the generator stopped writing, when the extraction
prompt started phrasing the same discovery differently, or when the work moved on and the fact
stopped being needed. Before crediting a fix: check the project had sessions after the span
ended, check Step 1 shows no fade over that period, and name the change you think caused it
with its date. Without all three it is `inconclusive`.

**Record every decision in `~/.claude-mem/state/harness-clusters.md`**, one line per cluster:
title, project, the run that raised it, and what was decided — written to `<file>`, judged
volatile, or declined as too rare. **Read it before proposing anything.** Without it each run
re-proposes what the owner already declined, and the assumption that a bad proposal will be
caught next time is false: the next run has no idea a judgement was ever made. Re-raise a
declined cluster only if its share has grown materially, and say by how much.

**A cluster needs a way to stop being reported, or this lane only ever grows.** Lanes B and C
are cumulative and each cluster's span is declared to be the finding, so nothing ever leaves:
a failure that stopped months ago prints in every run carrying its old span, indistinguishable
from one that happened yesterday. Mirror the rule the ledger already has for `verified` rows —
**a cluster whose newest occurrence predates the last two runs collapses to a single line**
carrying its span, its last date and its count. Collapsed, not deleted: deleting loses the
evidence that it was ever real, and the report needs to be able to say "this stopped" as much
as it needs to say "this recurs". Two guards, because both failure modes are easy to hit:

- **Collapse on recurrence, never on a fix being shipped.** A cluster nobody worked on that
  simply stopped is still a collapse. A cluster with a shipped fix that keeps recurring is not
  — that one is the ledger's problem, and collapsing it hides a fix that did not work.
- **A return reopens it at full size, and the reopening is itself a finding.** A failure class
  that comes back after two quiet runs says the fix addressed a symptom, and that is worth more
  than the cluster's own row count.

**This file is on probation, and the condition belongs inside it.** Exact-title matching is too
crude to cluster the same discovery worded two ways, and a run can return no stable cluster at
all — only bootstrap and build-outcome noise above the threshold. Write the condition into the
file's own header: if a run again returns no stable cluster, delete the file and say so in the
report.

Output per live cluster: title, project, times / sessions / exposure / days / span, and a
mechanical proposal naming the exact file to write the fact into.

**Set the thresholds against your own store, and record what you set.** Run the query at two or
three settings, count the clusters each returns, and pick the loosest one whose table a person
will actually read to the end. Write both the setting and the count into the series file, so a
later run knows whether a shorter list means less re-derivation or a tighter threshold. One step
of loosening can multiply the list several times over: the setting is not a detail.

### Lane C — errors the agent worked around instead of reporting

The failure mode this lane exists for: the agent hits the same wall for two months, silently
routes around it every time, and never once says so.

**What this lane actually measures, so the name does not oversell it:** a tool call the runtime
marked as failed whose text matched a signature. It does not establish that the agent then
routed around the failure silently, because nothing here reads the following call or checks
whether the user was told. Treat a large, long-running signature as *evidence worth opening*,
and confirm the silence the only way it can be confirmed — no prompt in the same period naming
it, per the agreement rule below.

**Run the script first — the transcripts are the honest source.** The store holds only the
errors the generator chose to write down, which is the agent judging its own case; the
transcripts hold every failed call as the runtime recorded it. Measured, the two disagree by
far more than rounding — count both once and see the size of your own gap before trusting either
number alone.

```bash
python3 <skill dir>/scripts/tool-errors.py                      # no --since: spans need all history
python3 <skill dir>/scripts/tool-errors.py --since <last run>   # only for "what is new"
python3 <skill dir>/scripts/tool-errors.py --raw 25             # the tail: group it, do not only match signatures
python3 <skill dir>/scripts/tool-errors.py --selfcheck          # before trusting a zero
```

**Run it without `--since` for the table, and with it only to see what is new.** The span is the
finding, and a cursor truncates every span at its left edge and hides outright any signature
that stopped before the last review — which is precisely the case worth knowing about. The
script's `data horizon` line reports the horizon *after* the filter, not how far the transcripts
actually go back.

It reads whichever runtimes are present, prints signature / hits / sessions / days / span per
runtime, and never prints transcript content — a few months of transcripts run to hundreds of
megabytes. **Its last line is the honest one:** how many failed calls matched no signature.
A large number there means the seed list has not yet learned this environment, not that
everything else was fine — run `--raw` and group the tail (below).

The formats are not equally honest. Claude Code and OpenCode flag a failed call, so their
counts are failures. Codex records no such flag, so its numbers are matches against all tool
output and are an upper bound; never put them next to a failure rate.

Then the store-side query below, which covers the same ground more coarsely but reaches back
past whatever transcript retention this machine has:

```bash
sqlite3 ~/.claude-mem/claude-mem.db "
WITH sig(pat,name) AS (VALUES
 ('%not permitted%','sandbox / permission denied'),
 ('%permission denied%','sandbox / permission denied'),
 ('%command not found%','missing tool'),
 ('%etimedout%','network timeout'),
 ('%could not resolve host%','network blocked'),
 ('%rate limit%','provider rate limit'),
 ('%unknown revision%','dependency fetch'))
SELECT s.name, count(*) hits, count(DISTINCT o.memory_session_id) sessions,
       count(DISTINCT date(o.created_at_epoch/1000,'unixepoch','localtime')) days,
       min(date(o.created_at_epoch/1000,'unixepoch','localtime'))||' → '||
       max(date(o.created_at_epoch/1000,'unixepoch','localtime')) span
FROM observations o JOIN sig s
  ON (lower(o.narrative) LIKE s.pat OR lower(o.facts) LIKE s.pat OR lower(o.title) LIKE s.pat)
GROUP BY s.name ORDER BY hits DESC;"
```

**Drop the rows this review wrote itself — in both sources.** Running this lane produces
observations that quote the error strings it searches for, and, worse, reading this file or a
previous review inside a session puts those same strings into that session's transcript — a
match count can double with no new failure behind it. Exclude the sessions in which a review
ran, by id, before reading either table.

**Group the whole tail, do not only match signatures.** A hand-maintained list cannot converge on
the shape of this data — it matches a minority of the failures, while grouping every failed call
by normalised text yields far more distinct shapes than any list holds. Run `--raw`, normalise
(strip paths, digits, ids, whitespace), group, and sort by sessions × days. **The tail is where
the useful findings are**, and they never appear in the signature table. The signature list
tracks known classes over time; the grouping finds the next one.

**The signature list is a seed, not a vocabulary** — the same trap as classifying prompts by
keyword. Read the period's `failed_attempt` observations and add the signatures this
environment actually produces, in the run itself; the list lives in this file and in the query
above, not in a state file of its own. **Version the method, not the list.** What stays
comparable between runs is how the tail was grouped (what was normalised away, what the ranking
key was), so record a Lane C method version in the series row and say which version produced a
count.
Widening the seed list changes nothing about comparability as long as the grouping is unchanged;
changing the grouping does, and that is what the version is for.

**A span that ends is the most valuable row in this table.** A signature that recurs across many
sessions and then stops on the day a workaround was written into the instructions file is a
harness fix proving itself without anyone having predicted it, which is exactly what a ledger row
wants as evidence. A span that reaches today is the opposite: the same obstruction, still there,
still routed around, with no prompt about it.

**The script's table cannot satisfy the citation contract on its own.** A row reading "path
guessed wrong" with a count names no path, and the output contract requires rows. Before proposing anything from this
lane, take the signature back to the source and pull two or three concrete instances — session
id, timestamp, and the tool or path involved — and cite those. A proposal that cites only an
aggregate is rejected like any other uncited proposal.

Proposals from this lane are usually one config line — a path whitelisted, a host allowed, a
tool installed.

### Lane D — the rules the harness already has

Every other lane looks for failures nobody wrote a rule about. This one asks the opposite
question: **of the rules already written, which are actually obeyed?** A prohibition that is
stated, injected into every session, and ignored is worse than no prohibition — it is paid for
continuously and it manufactures confidence that the question is closed.

Read the instruction files in force for this runtime — see the table above, plus the skills that
load by default — and pull out the prohibitions that would leave a trace in the data. Rules
about files leave one today, in `files_read` and `files_modified`; rules about commands live in
the transcripts and are out of reach of this lane.

**The patterns are yours to write — this file deliberately ships none.** A prohibition worth
counting is one your own instruction files state, over paths your own stack produces. Copying
someone else's list measures their repository. One `SELECT` per rule, unioned:

```bash
sqlite3 ~/.claude-mem/claude-mem.db "
WITH win(floor) AS (VALUES (strftime('%s','<last run, YYYY-MM-DD>')*1000)),
     sess AS (SELECT count(*) n FROM sdk_sessions, win WHERE started_at_epoch > floor)
SELECT '<name the rule>' rule, count(*) hits,
       count(DISTINCT memory_session_id) violating_sessions, (SELECT n FROM sess) window_sessions,
       round(count(DISTINCT memory_session_id)*100.0/(SELECT n FROM sess),1) pct
FROM observations, win
WHERE created_at_epoch > floor
  AND files_read LIKE '%<the prohibited path fragment>%';"
```

**Escape an underscore in a pattern** — `LIKE '%_x%'` treats `_` as a single-character wildcard,
so a rule about `_generated` files silently matches far more than intended. Write
`LIKE '%\_x%' ESCAPE '\'`.

**This lane does use the review window** — unlike Lanes B and C, where the span is the finding.
A cumulative count can only ever rise, so it says nothing about whether a rule started working.
The window is built with `strftime`, **not by pasting the cursor**: the cursor is an ISO string
and the column is epoch milliseconds, and SQLite compares those without complaining and returns
zero rows — a clean report produced by a type mismatch.

**Report violating sessions against the window's sessions, never the raw count.** A quiet
fortnight produces fewer violations of everything, so a rule nobody obeys reads as fixed. If
the window holds too few sessions for a rate to mean anything, the honest score for the ledger
row is `unexposed`.

**Even the rate measures task mix, not obedience.** A period with no work of the kind a rule
governs scores perfectly on it. The unit this lane cannot compute is the *opportunity* — the sessions
in which a prohibited file could plausibly have been read — and until something records it,
every number here is a floor with a moving denominator. Say that where the number is reported.

Two more distortions to state rather than smooth over: `files_read` is written by the generator,
so an outage improves compliance; and one observation naming ten prohibited files counts once,
while ten observations naming one file count ten times.

**This lane asks only half its question.** *Which written rules are obeyed* is the half that is
easy to count. The productive half is *which rule is missing* — the situation that keeps costing
something and that no rule addresses at all. Nothing above finds it, and when the owner asks
directly ("what gaps could a rule or a script close?") a run with no method for it will
improvise.

The method is the error tail and the other lanes, read with that question in mind: a failure
class that recurs and that no instruction file mentions is a missing rule, and it is the only
place new rules come from. Propose it the same way as any other — mechanically, cited, and
grepped first.

Two outcomes, and the second is the one that gets forgotten:

- **Violated and still stated → propose the mechanism, not a louder sentence.** A hook, a
  permission rule, a deny entry. The rule has already been tried in prose and the count is the
  measurement of how that went.
- **Never violated → do not propose deleting it on that evidence alone.** Two independent
  reviews warned about this and an earlier version of this file shipped the deletion rule
  regardless, which is why the warning is written out here rather than assumed. Zero
  violations reads identically for a rule that is working, a rule that never had the chance to
  fire, and a safety rule whose whole value is the rare case. Deletion needs *positive* evidence:
  the situation the rule governs demonstrably occurred in the window and the rule was followed —
  then it is doing nothing the agent would not do anyway. Absent that, the score is `unexposed`
  and the proposal is nothing. A harness should shrink as well as grow, but not blindly.

### Lane E — how tasks actually ended

**Not built. Do not improvise it, and do not silently omit it.** The store records what the
agent did, never whether the result was accepted, sent back, or abandoned. Without that, work
that was quietly redone is indistinguishable from work that landed.

This lane needs a task registry — a spec directory with a status per task that something
maintains. Until that exists, the honest line in the report is "no outcome lane; task outcomes
were not measured", never a favourable silence.

**This is the lane that matters most for autonomous work.** Where the user only assigns tasks
and never corrects, the prompt lane approaches zero and this file would print "no corrections
found" while everything burned. In that mode the load-bearing signal is the task outcome, and
prompts demote to a drift detector: if successive briefs grow new constraints, the defect is
alive and is being absorbed by the brief instead of being fixed.

### The registry check — beside Lane E, and not Lane E

**Leave the stub above exactly as it stands, and keep the five-lane enumeration in the output
contract as it is; this check reports on its own line.** Lane E asks how a task ended — accepted,
sent back, redone, abandoned. This asks one mechanical question: **does a `DONE` marker mean the
work reached the default branch.** Labelling it Lane E would let the next run read "the outcome
lane exists" and stop looking for the real one, which is the favourable silence this file exists
to prevent.

**Run it where the pipeline keeps durable progress files** — a spec or run directory whose files
declare a status per task, and gate logs carrying a pass/fail verdict. Both are greppable and
both can be checked against git, which is what separates this from asking the store how work
ended. If no such directory exists, say so and stop; do not reconstruct task outcomes from
observations.

**Print the size of the sliver, every time.** A registry covers the work that went through the
pipeline, which is a fraction of the work the store holds — and a silent result here reads as
"tasks ended fine", the same favourable silence. State how many tasks the registry carries
against how many the store does, in the same line as any finding.

**The obvious verifier is wrong where the default branch is squash-merged.** Checking whether a
recorded commit is an ancestor of the default branch returns *not an ancestor* for every task
that landed, because the squash rewrites the commit — a mechanical check that can report a
total failure rate on work that all shipped. Verify through the merge reference instead: the PR
or merge identifier in the squash subject. Before trusting either result, confirm the branch's
merge policy; the check is only as good as that assumption.

**Where the registry does not record where a task landed, say so in three numbers, never a
verdict**: tasks marked done, tasks verifiable, tasks unverifiable for want of a merge
reference. That gap is itself the check's first real finding — a registry that cannot verify
itself needs one line added to its template at merge time, which is a mechanical proposal like
any other.

### Making the lanes agree

The prompt lane's number is only as good as another lane's confirmation, and "confirmation" has
to be a procedure or it is a mood. For the period being reported, per signature and per live
cluster: how many of the period's days did it run, and how many prompts mention it.

**"Mentions it" is a judgement unless you write the rule down.** A complaint about a build
failing may or may not be about the sandbox denial underneath it, and two runs will split
exactly on the cell that decides whether the prompt lane is blind. Keep a signature → wordings
mapping in the vocabulary file, built while reading the window and versioned with it: a prompt
counts as mentioning a signature when it names the failure or the blocked resource, not when it
merely occurred near one.

- **Active most of the period, zero prompts about it → the prompt lane is blind for that
  period**, and a fall in the correction rate is not evidence of improvement. Say this in the
  report next to the rate, not in a footnote.
- **Active and prompts mention it → the lanes agree**, and the prompt rate can be read at face
  value for that period.
- **Nothing active in any lane and the correction rate fell** → the strongest reading available,
  and still not proof: the pre-emption effect is invisible to every lane here.

The first case is the common one: a permission denial recurring for months across many sessions,
no prompt ever complaining about it, and a correction rate over the same period that looks fine.

## A sweep is one pass of two, and the first pass produces candidates

Whenever a lane is worked by fanning agents across slices of history, **what comes back is a
lead list, not a result**. First-pass findings are wrong often enough that reporting them as
findings means reporting a set whose headlines have not been checked — and the ones that do
survive are usually *restated* rather than confirmed, so even "confirmed" rarely means "as
written". Send each finding back for a dig against the primary evidence before it reaches the
report. The dig is cheap enough to be mandatory because the evidence is already on disk: one
agent per finding, settled in minutes.

**Budget the dig by strength, not by coverage.** One agent per finding, digging the strongest
finding of each slice, beats confirming many weak ones — a withdrawal is not wasted work when
what replaces it is better, and in practice the replacement is the smaller, harder, more useful
claim.

**Check what the finding's own evidence was authored by.** A withdrawal can invert: a finding
that a brief cited something "that was never in the repo" has been settled by the tree showing
the thing present for years — the absence had been written down by an agent whose search
missed, and then cited as fact by everything downstream. When a dig touches a claim of absence,
settle it against the tree, and if the claim came from a document rather than the tree, the
finding is not the absence but **a failed search promoted to a documented fact** — a different
and more serious defect than the one reported.

**What the second pass is for is replacement, not confirmation.** The pattern to expect: a
sweeping headline dies and a narrower mechanism takes its place. "Many sessions hunting for a
module" becomes a statement about what a dispatched agent has to re-pay for. "Merging on red
became routine" becomes a statement about a gate whose failures carry no information. Write the
replacement, not the headline it replaced.

### Every count states which of three levels it is on

A `session_summaries` row is one summarisation checkpoint, roughly one per prompt.
`memory_session_id` groups checkpoints but is **not** a conversation — one conversation is
chopped across several groups. The conversation key is the uuid embedded in the
`memory_session_id` string. Rows overstate conversations heavily, and by a factor that belongs
to the store being read — compute it, never assume it. A count that does not name its level is
not a count: state the level in the finding, rows or groups or conversations.

**`sdk_sessions` is not the way to resolve this.** It holds one row per conversation while
`session_summaries` holds many groups per conversation, so a join through it silently drops
most of the history — and a group under investigation may have no `sdk_sessions` row at all.
Derive the conversation from the id string instead.

Most first-pass withdrawals trace to this one confusion. "N consecutive sessions doing X" is the
shape it takes, and it dissolves on inspection into one dispatched agent writing many
checkpoints in seconds, or one conversation lasting half an hour.

### The summariser has four systematic failure modes; discount for them by name

- **It narrates its own duplicates as repetition.** Re-emitting a still-pending closing line at
  each checkpoint produces rows that say "asked for the third time", "for the fourth time". The
  store manufactured the stall it is now reporting.
- **`next_steps` renders "gave a recommendation and offered to proceed" as "awaiting user
  decision".** Every parked, blocked or awaiting-approval claim is inflated by this. Re-read the
  rows before counting them, and measure the inflation on your own store if you intend to
  report the count.
- **`type` is unreliable inside a burst.** Rows written in quick succession inherit one type,
  including rows whose subject plainly is not that type. Do not build a count on `type` alone.
- **A claim about the store's own behaviour is a hypothesis** — a generator's conclusion about
  the thing that wrote it. Re-check it, and retract a disproved one in place, per Step 2.

### git is the reliable second source; transcripts frequently are not

A claim about code is settled by the tree as it stood on the date in question — `git log -S`,
`git show`, `git branch --contains`, `git ls-tree` — not by prose about it. Session transcripts
are not a dependable second source: they may be absent for exactly the period a dig needs, and
they carry no retention guarantee. **Write "no transcript survives for this period" as a loud
line; never read its absence as absence of errors.** Where the pipeline writes durable artefacts
— gate logs, progress files — prefer those over any summary of them.

## What the run costs — price it in tokens, and never in money

**The source needs no instrumentation.** Every dispatched agent writes its own transcript under
`~/.claude/projects/<project>/<session-id>/subagents/agent-<name>-<id>.jsonl`, one file per
agent, and every assistant line carries a `usage` object. Summing usage per file gives a
per-agent cost after the fact, for any run whose transcripts survive.

**Report `output_tokens` alone, and name the field in the series row.** Cache reads and cache
writes dwarf output by orders of magnitude; summing them makes every run look catastrophic and
mostly measures how much context was re-sent, which tracks conversation length rather than work
done. Output tokens track what the agent produced. Name the field, or the next run picks a
different one and the series stops being a series.

**No dollar figure exists anywhere in the harness.** The transcripts carry no cost field, and a
rate invented here would be a number with no source that later reads as measured. Prices change
and would break comparability across a series; token counts do not.

**Four numbers in the series row:** agents dispatched, output tokens, findings that survived the
dig, and the derived cost per surviving finding.

**One caveat travels with the number:** the lead session's own tokens are not in the subagent
files. For a whole-review figure, add the parent transcript; for comparing fan-out designs, the
subagent files alone are the honest unit.

**The cost number only bites when paired with the withdrawal rate.** A run that halves
withdrawals while doubling the cost per surviving finding has not improved, and without both in
the same row nobody can tell which happened.

## Output contract

**Ledger status first, then the numbers, then the proposals, nothing else.** A report without
the ledger section is void — see Step 0.

**Open loops first, then ledger status, then the numbers.** A report that opens with fresh
findings while the owner's own unshipped proposals sit unlisted has its priorities backwards.

**Name the lanes, one line each, including the ones that produced nothing.** Prompts,
re-derived facts, worked-around errors, rule compliance, task outcomes — five. A lane that was skipped, that came back
empty, or that does not exist yet reads exactly like a lane that ran clean, and the difference
is the whole value of the report. "No outcome lane" is a result; silence is not.

**The prompt lane reports two counts, side by side and never merged into one:** corrections —
the user repairing something the agent did or failed to do — and the constraints the user loaded
into a request *before* anything failed, because they had learned the agent would otherwise get
it wrong. The second is not part of the correction rate and never enters it; reported alone,
either one can fall for the wrong reason (see the prompt lane, and the trap it is the instrument
for). Refer to them by shape here — whatever the vocabulary file calls the second one is that
store's business, not this contract's.

**A period with none of the second kind is reported as zero.** An omitted count and a count of
zero read identically to the next run, and only one of them is evidence: zero says the lane was
read and the shape was absent, silence says nothing at all. Same rule as the lanes above.

**Report what improved, held to the same evidence standard as everything else.** A report made
only of failures describes a harness that has never once got better, and the owner cannot tell a
period where the fixes held from a period where nobody checked. Sources, all already
computed by this run: ledger rows scored `verified`, error signatures whose span ended — a fix
proving itself — and any count whose share fell against the previous series row. A line here
carries its own number like every other line, or it is a mood.

**One more source, and it records the opposite thing: a practice that worked and is worth
keeping.** Everything above is pain that stopped, and so is the question put to the owner about
what he did not have to say this period. A method that did work shows up in none of them — it
leaves no failed rows to fall and no error span to end — so without this source the report can
only ever say the harness hurts less, never that it does something well enough to keep.

**Its job is intake, not applause.** A candidate found here goes to the rule on how a skill gets
created — proposed by the agent, ruled by the owner, confirmed by a first use that did not have
to rewrite it — and it does not also become a finding of its own. Two lists of the same
candidates drift apart within a run or two, and the one that is only a report line is the one
nobody acts on.

**The bar is that rule's bar, and it is not optional here**, because this is the easiest line in
the whole report to fill with self-congratulation: every other lane counts artefacts, this one
risks counting impressions. Both halves have to hold:

- **It can be written as steps that work with its author out of the loop.** A judgement made in
  flight is not a procedure — written down it comes out as a retelling of intent, and it will not
  fire for anyone else.
- **It is visible in something the agent did not author** — a commit, an error span that ended, a
  prompt from the owner. "The run went well" is the agent grading its own work, and it does not
  qualify however well it reads.

**Nothing in the practitioner corpus does this, and a later run should not go hunting for a
precedent.** Harvesting a successful procedure is missing from the systems that have been looked
at, retiring one is rarer, and a lane whose subject is what worked rather than what failed is
rarer still. This is invention, not catching up — which is exactly why it carries the same
evidence standard as every other line here: nothing outside this file validates it.

Every proposal must be **mechanical** — a hook, a prohibition, a config field, a settings
entry, a schema change, an edit to a prompt file — and must **cite the specific evidence that
produced it**, by row: prompt ids, observation ids, or log lines.

- No citation → rejected.
- Citing prompts is not required. The whole point of the non-prompt lanes is that the worst
  failures draw no complaint at all — the accepted example below is built on observations and
  zero prompts. Demanding prompt citations would reject it.
- The citation must **support** the claim, not merely be adjacent to it. Check the cited rows
  say what the proposal says they say.
- "Build the habit of…", "add an explicit step", "consider surfacing…" → rejected. Nothing
  enforces them and nothing verifies they happened.
- **Grep the instruction files before proposing anything, every time.** A proposal to write down
  a rule that is already written is a no-op that closes a serious finding: the rule exists and
  is not being followed, which needs enforcement, not restatement. Restating a rule already in
  force is the single commonest defect in a proposal set, so this is a precondition on every
  proposal, not a step belonging to one lane.
- Nothing mechanical found → report **"no new fixable failures this period"**. Do not invent
  one. A clean period is a legitimate result and the whole point of counting.

**Rank by consequence, with the count as a second column.** The obvious ordering — how many rows
a proposal would close — puts the cheapest, most frequent friction on top and buries the group
that took something down, which typically sits near the bottom by row count while owning most of
the S1 rows. Sort by the worst outcome in the group; break ties by rows closed.

**Split the proposals by whether they need you.** Reversible, narrowly scoped, and verifiable
inside this run — a config line, an allowlist entry, a tool install — **the run applies itself**,
with a live probe before and after as the evidence, and writes its own ledger row. Everything
else — policy, anything that costs money, anything irreversible — goes to the owner as now.
Without this split the throughput of the whole exercise is however many fixes fit in one
conversation before the person gets bored: one measured run proposed twenty-one groups and
shipped two, both only because the owner happened to be sitting there. The line is drawn by the
agent, so state which side each proposal was put on and why.

**Track the review's own unshipped proposals.** The owner's asks have a file; the review's
proposals have nothing, so they live in one report and the next run re-derives them from scratch
and calls them new. Same file, same statuses, other direction: keep them beside the open loops
and score them the same way.

**Close the run with a state audit.** A run leaves seven artefacts on disk: the **five mandated
state files** — ledger, open loops, series, vocabulary, cursor — plus the local evidence file,
plus `harness-clusters.md` for as long as it is on probation. Print a table at the end: each file,
**its size**, whether it exists, and whether this run touched it. A run that reports numbers and
wrote nothing has produced an impression, and the next run inherits nothing to compare against
— which is the failure this whole file exists to prevent. The size column is what makes growth
visible a run or two before it starts eating the context budget every later run pays. It costs a
directory listing.

**A file earns its place only if it is a mandated read at a moment when the store cannot be
relied on.** Anything else that was written here has been retired: a per-run window file (the
cursor holds both numbers), and a signature list kept as state (the method is versioned in the
series row instead). Do not reintroduce them, and do not add a file without stating which
mandated read it serves.

**Ask the owner what they already knew — but only about the findings that could be news.**
Against each, one of three answers: *knew* / *did not know* / *wrong*. Nothing else separates
this from the thirtieth retrospective, because a review that tells you what you already knew
feels productive and changes nothing. Record the answers in the series file.

**Do not spend the question on a single prompt.** Every row in the prompt lane is a sentence the
owner typed and remembers; asking whether it is news is close to tautological, and the answer is
always *knew*. Spend it on the aggregates — what had to be repeated, what preamble appeared,
where corrections cluster — and on the lanes the owner cannot see from inside a conversation.
On one measured run, both genuine discoveries came from outside the prompt lane, and that is
structural rather than luck.

If almost everything still comes back *knew*, the lanes are confirming rather than discovering,
and the next run should change where it looks rather than how it counts.

**Ask what worked, in the same breath.** *Knew / did not know / wrong* grades the findings and
nothing else; it never asks what the harness stopped doing to the owner. One more question — what
did you not have to say this period, what is working now that used to need repeating — recorded in
the series file beside the verdicts. No query reaches this: relief is not an event, so a fix that
succeeded leaves the store looking exactly like a period nobody worked on. The answer is also the
only defence against removing something that is quietly holding, which is the one mistake this
whole file's deletion bias can produce.

**Have the citations checked by someone who did not write them.** The rule above — the citation
must support the claim, not merely sit near it — is the one part of this contract with nothing
enforcing it, and the author of a proposal is the worst possible checker of its evidence. Hand
a subagent the proposals and the cited row ids **only**, with no reasoning attached, and ask it
to refute each one. Drop what it refutes. **If this runtime has no subagents, say in the report
that citations went unverified** — do not quietly self-check and present it as the same thing. This is the one place in the review where a subagent
earns its cost: the lanes themselves return two dozen aggregate rows and belong in one context,
and independent agents given the same judgement task have been measured agreeing on a small
fraction of findings — they diverge rather than cover.

| Rejected | Accepted |
|---|---|
| "Consider a lighter-weight surfacing habit on scope-changing calls" | "Whitelist these two cache paths in the sandbox config — N observations across the period hit `Operation not permitted` on them, and twice the agent's fallback was to disable the sandbox entirely" |

## Retiring this file's own rules

Every rule here was written in response to a measured failure class, and nothing here takes one
out again. A review whose only available move is to add a prohibition grows in one direction
until it stops being read in full — and a rule nobody reads enforces nothing, whatever it says.

**Record the failure class beside the rule, in the run that writes the rule.** Not afterwards and
not reconstructed later: the run that adds a rule is the only one that holds what it was reacting
to, and a rule whose class cannot be named was never grounded in anything measurable in the first
place.

**Then use the mechanism this file already has, pointed at a different subject.** Lane B collapses
a cluster whose newest occurrence predates the last two runs. Apply that same bookkeeping to the
rules: a class that has not recurred across the same two quiet runs makes its rule a candidate for
removal. This is deliberately not a second scheme — one quiet-period convention with two subjects,
so the runs that count for a cluster are the runs that count for a rule, and neither needs a
counter of its own.

**A candidate is confirmed by one ablation, and never by the counter.** The quiet period only
nominates; nothing is removed because a period expired. It is removed after a single run performed
without the rule: if the finding the rule exists to produce still comes out, the rule was not doing
the work. This is the local substitute for the published signal — the base model passing a skill's
evals with the skill unloaded — which is unavailable here because there are no evals to pass. A
later run should know which of the two it is holding: the same logic on a weaker instrument.

**The weakness belongs in the rule, not in whatever a reader works out later: a rule that is
working looks exactly like a rule that is unnecessary.** Neither produces failures — not producing
failures is what a working rule does. No count separates them, and the ablation is the only thing
that can:

- **One suspect at a time.** A run performed without several rules cannot attribute its result to
  any one of them, so the tempting cleanup — drop the whole quiet set, see whether anything breaks
  — produces an answer that cannot be read. A batch ablation is not a cheaper version of this
  check; it is not the check.
- **It costs a whole run**, and that is the price of the only honest answer available here. A
  candidate waits its turn, and a run carrying an ablation says so in its report, because every
  number it produces was measured under a different rule set than the run before it.
- **A returning failure class reopens the rule, and the reopening is a finding** — the mirror of
  the cluster rule's own return, and load-bearing rather than tidy. Removal rests on a single
  run, so a class coming back is the only evidence that run was read wrong, and without this half
  retirement is one-directional: nothing catches a rule removed for the wrong reason. Report it
  rather than quietly restoring the rule, or the file re-grows with no record of why anything left
  it or came back. **The ablation that authorised the removal is retired along with it** — it is
  now known to have been misread, and it does not count as evidence for removing that same rule
  again, or the rule gets ablated away run after run on a result already shown to be misleading.
  **The restored rule carries the round trip in its own text**: removed, class returned, restored.
  A rule with no history cannot be told apart by the next run from one that was never questioned,
  which is the retraction format's reasoning applied to a rule — the record and the reason it
  moved stay together.

## Common mistakes

Each was observed in baseline runs of this exact task, three of three agents unless noted.

| Mistake | What it costs |
|---|---|
| Reading prompts first, counting later or never | The retro becomes an impression. No number moves, so no fix can be shown to have worked. |
| Reporting a total row count as evidence the store is fine | A dead store and a healthy one have identical totals. Three of three missed a three-day outage this way. |
| Classifying by keyword search | One run searched for two reason-demanding phrasings and never saw the period's largest category at all, because its owner's word for it was not on the list. |
| Counting label frequency in observations instead of prompts | Observation labels track the extraction prompt, not reality; one type has been measured mistyped for months on end. Prompts are the user's own words — but see the row below before treating them as stable. |
| Treating the prompt stream as a stationary instrument | The words do not drift; the *behaviour* does. Once the user learns the agent drops items, they write "and don't forget X" in advance. The "you forgot X" prompt disappears, the defect does not. A falling correction rate is not evidence of improvement until a non-prompt lane agrees. The instrument that tells the two apart is the pre-emptive-instruction tag in the prompt lane; count it, do not just avoid the trap. |
| Presenting claude-mem's own audit findings as new discoveries | The audits wrote their conclusions into `observations`, so a retro will "find" them. Ask whether a finding is about the work or about a previous review of the work. |
| Proposing prose habits | See the contract above. |
| Running the prompt lane and calling it the review | The lane goes quiet as the user adapts around a defect, and it never held the silent failures at all. A correction rate that fell while Lane C shows the same denial for two months has not measured an improvement. |
| Reading a re-derivation cluster as waste without checking the type | Half the list is branch SHAs and task status, which *should* be re-derived every session. Proposing to write those down produces instructions that rot within a day. |
| Proposing "document this" without grepping the docs first | If the fact is already in `CLAUDE.md` and was still re-derived nine times, the defect is in what gets read, and the proposal as written would close a serious finding with a no-op. |
| Trusting an instruction in this file over what the tool actually returns | Every defect in the row below shipped inside this skill and survived two GREEN runs. Check the instrument, then the data, then the claim. |
| Reporting a clean period without saying which lanes were degraded | A rejected liveness call, a classification step reading truncations, false-positive rules that cannot be computed — a report that hides any of it reads exactly like a healthy one. |
