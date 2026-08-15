// FORK-OWNED: staleness threshold for the PreToolUse:Read timeline.
// mtime is a poor stale signal — every merge/checkout bumps it even when the
// file's content is untouched, so the "may be stale" marker covered ~90% of
// entries and carried no information. Use the last *content* change instead:
// the newest commit touching the path, or mtime when the working copy is
// dirty/untracked. Any git failure falls back to mtime (the old behavior).
import { execFileSync } from 'child_process';

const GIT_TIMEOUT_MS = 1_500;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

export function getContentStaleThresholdMs(absPath: string, cwd: string, mtimeMs: number): number {
  try {
    const dirty = git(cwd, ['status', '--porcelain', '--', absPath]);
    if (dirty.length > 0) return mtimeMs; // uncommitted edits: content changed at mtime
    const lastCommitEpochS = git(cwd, ['log', '-1', '--format=%ct', '--', absPath]);
    if (!lastCommitEpochS) return mtimeMs; // no history for the path
    const parsed = Number.parseInt(lastCommitEpochS, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : mtimeMs;
  } catch {
    return mtimeMs; // not a repo, git missing, or timeout — old behavior
  }
}
