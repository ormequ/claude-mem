#!/usr/bin/env bun
// FORK-OWNED CLI: review and adopt memory rows from deleted worktrees.
//
// Runs from the dev checkout and imports src/ directly, whereas `adopt-mem`
// otherwise execs the INSTALLED plugin-cache build. The two are different
// slices of the code; this command only depends on the merged_into_project /
// chroma_merge_synced_at columns, and adoptOrphan checks for them explicitly
// rather than crashing on a schema mismatch.
import {
  scanOrphans, readDeclines, recordDecline, resetDeclines, isSuppressed, adoptOrphan,
  type OrphanCandidate,
} from '../src/services/infrastructure/OrphanAdoption.js';
import { resolveMainRepoPath } from '../src/services/infrastructure/WorktreeAdoption.js';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const doReset = argv.includes('--reset-declined');

// Accept both `--repo <path>` (space-separated) and `--repo=<path>` (equals
// form) — the latter is easy to reach for and was silently swallowed before.
const repoEqualsArg = argv.find(a => a.startsWith('--repo='));
const repoIndex = argv.indexOf('--repo');
const repoPath = repoEqualsArg
  ? repoEqualsArg.slice('--repo='.length)
  : repoIndex !== -1 ? argv[repoIndex + 1] : undefined;

if (repoEqualsArg && repoEqualsArg.slice('--repo='.length) === '') {
  console.error('Usage: adopt-mem --orphans [--dry-run] [--reset-declined] [--repo <path>|--repo=<path>]');
  process.exit(1);
}
if (!repoEqualsArg && repoIndex !== -1 && (!repoPath || repoPath.startsWith('--'))) {
  console.error('Usage: adopt-mem --orphans [--dry-run] [--reset-declined] [--repo <path>|--repo=<path>]');
  process.exit(1);
}

// A path that just doesn't resolve to a git repo produces the same generic
// "not resolvable — pass --repo <path>" skip message as not passing --repo at
// all, which is confusing when the user just typed --repo. Say plainly what's
// wrong with the given path up front.
if (repoPath && !resolveMainRepoPath(repoPath)) {
  console.error(`! --repo ${repoPath} did not resolve to a git repository`);
}

// Whether this run is allowed to write anything at all — the single gate
// both --reset-declined and the interactive adopt loop below must honor.
// `--dry-run` and a non-TTY stdin must write NOTHING: not to the database,
// not to the declines file.
const mayWrite = Boolean(process.stdin.isTTY) && !dryRun;

if (doReset) {
  if (mayWrite) {
    resetDeclines();
    console.log('Cleared all recorded declines.');
  } else {
    const count = readDeclines().size;
    console.log(`(no TTY or --dry-run: would clear ${count} recorded decline${count === 1 ? '' : 's'} (all projects, not only those listed below))`);
  }
}

const total = (c: OrphanCandidate) => c.observations + c.summaries;
const day = (iso: string) => iso.slice(0, 10);
const line = (c: OrphanCandidate) =>
  `  ${c.project.padEnd(38)} ${String(total(c)).padStart(5)} rows   ${day(c.firstSeen)} – ${day(c.lastSeen)}`;

// scanOrphans does NOT open the SQLite DB read-only — openConfiguredSqliteDatabase
// opens for write, and on a non-WAL database this genuinely converts it to WAL
// and creates -wal/-shm files, even under --dry-run. That conversion is a
// no-op in production, though: the worker already maintains the DB in WAL
// mode, so `PRAGMA journal_mode = WAL` on this open finds nothing to change,
// and it does not contend for the worker's write lock. But if scanOrphans
// ever does throw for any reason, a read command shouldn't die with a raw Bun
// stack trace — surface the same plain-language "database is locked" message
// the adopt loop below uses for that specific error, and a generic one
// otherwise, and exit non-zero so a failed run never looks like a clean one.
let result: ReturnType<typeof scanOrphans>;
try {
  result = scanOrphans({ repoPath });
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('database is locked')) {
    console.error(`! the claude-mem worker is busy writing; try again in a moment (${message})`);
  } else {
    console.error(`! could not scan for orphaned worktrees: ${message}`);
  }
  process.exit(1);
}
const declines = readDeclines();
const pending = result.orphans.filter(c => !isSuppressed(c, declines));

for (const name of result.ambiguousParents) {
  console.log(`! several repos resolve to "${name}" — a worktree is only called orphaned when absent from all of them`);
}
for (const skip of result.skipped) {
  console.log(`! skipped ${skip.project}: ${skip.reason}`);
}

if (pending.length === 0) {
  console.log('\nNo orphaned worktrees awaiting a decision.');
} else {
  console.log(`\nOrphaned worktrees (directory deleted) — ${pending.length}`);
  for (const c of pending) console.log(line(c));
}

if (result.live.length > 0) {
  console.log('\nLive worktrees holding unadopted memory (not touched):');
  for (const c of result.live) {
    console.log(`${line(c)}   run adopt-mem <path> when you are done`);
  }
}

if (!mayWrite || pending.length === 0) {
  if (pending.length > 0) console.log('\n(no TTY or --dry-run: nothing was changed)');
  process.exit(0);
}

function ask(question: string): Promise<string> {
  process.stdout.write(question);
  return new Promise(resolve => {
    process.stdin.setEncoding('utf8');
    const cleanup = () => {
      process.stdin.pause();
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
    };
    const onData = (chunk: string) => {
      cleanup();
      resolve(chunk.trim().toLowerCase());
    };
    // Ctrl-D (EOF) never fires 'data' — without this the promise never
    // settles and the process hangs on a prompt no one can answer. Treat it
    // the same as an explicit 'q': stop the run cleanly, adopting/declining
    // nothing further.
    const onEnd = () => {
      cleanup();
      resolve('q');
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
  });
}

let adoptedObs = 0;
let adoptedSums = 0;
let adoptAll = false;

console.log('\n  y = adopt into parent   n = skip & remember   a = adopt all remaining   q = quit');

for (const c of pending) {
  let answer = 'y';
  if (!adoptAll) {
    answer = await ask(`\nAdopt ${c.project} into ${c.parentProject}? [y/n/a/q] `);
  }
  if (answer === 'q') break;
  if (answer === 'a') adoptAll = true;
  if (answer === 'n') {
    recordDecline(c.project);
    console.log(`  declined — not asked again until ${c.project} gains newer rows`);
    continue;
  }
  if (answer !== 'y' && answer !== 'a') {
    console.log('  skipped (no answer recorded)');
    continue;
  }
  // The claude-mem worker writes to the same SQLite DB on every observation
  // ingest. If it holds the write transaction when we get here, adoptOrphan
  // waits out busy_timeout (~5s) and then throws a raw "database is locked"
  // error. Nothing is written when that happens, so surface a clear message
  // and move on to the next candidate rather than aborting the whole run.
  let changed: { observations: number; summaries: number };
  try {
    changed = adoptOrphan(c.project, c.parentProject);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('database is locked')) {
      console.log(`  ! the claude-mem worker is busy writing; nothing was adopted for ${c.project}, try again in a moment (${message})`);
    } else {
      console.log(`  ! nothing was adopted for ${c.project}: ${message}`);
    }
    continue;
  }
  adoptedObs += changed.observations;
  adoptedSums += changed.summaries;
  console.log(`  adopted ${changed.observations} observations + ${changed.summaries} summaries into ${c.parentProject}`);
}

if (adoptedObs + adoptedSums > 0) {
  console.log(`\nAdopted ${adoptedObs + adoptedSums} rows total.`);
  console.log('Chroma is patched by the worker on its next drain (up to an hour) — semantic search lags until then.');
}
process.exit(0);
