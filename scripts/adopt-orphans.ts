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

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const doReset = argv.includes('--reset-declined');
const repoIndex = argv.indexOf('--repo');
const repoPath = repoIndex !== -1 ? argv[repoIndex + 1] : undefined;

if (repoIndex !== -1 && (!repoPath || repoPath.startsWith('--'))) {
  console.error('Usage: adopt-mem --orphans [--dry-run] [--reset-declined] [--repo <path>]');
  process.exit(1);
}

if (doReset) {
  resetDeclines();
  console.log('Cleared all recorded declines.');
}

const total = (c: OrphanCandidate) => c.observations + c.summaries;
const day = (iso: string) => iso.slice(0, 10);
const line = (c: OrphanCandidate) =>
  `  ${c.project.padEnd(38)} ${String(total(c)).padStart(5)} rows   ${day(c.firstSeen)} – ${day(c.lastSeen)}`;

const result = scanOrphans({ repoPath });
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

const interactive = Boolean(process.stdin.isTTY) && !dryRun;
if (!interactive || pending.length === 0) {
  if (pending.length > 0) console.log('\n(no TTY or --dry-run: nothing was changed)');
  process.exit(0);
}

function ask(question: string): Promise<string> {
  process.stdout.write(question);
  return new Promise(resolve => {
    process.stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      process.stdin.pause();
      process.stdin.off('data', onData);
      resolve(chunk.trim().toLowerCase());
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

let adoptedObs = 0;
let adoptedSums = 0;
let adoptAll = false;

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
    console.log(`  ! the claude-mem worker is busy writing; nothing was adopted for ${c.project}, try again in a moment (${message})`);
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
