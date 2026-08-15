// FORK-OWNED: durable registry of workspace cwds the worker has ingested.
//
// Why this exists: merged-worktree adoption discovered its repo list from
// `pending_messages.cwd`. That table is a transient queue — rows are deleted
// as soon as the observation is processed — so it is empty almost all of the
// time. `adoptMergedWorktreesForAllKnownRepos` therefore resolved to zero
// parent repos and returned early at a `logger.debug` line, which is not
// written to the log file at all. Both callers were affected: the worker-boot
// pass and the hourly AdoptionScheduler tick. The feature FORK_NOTES
// advertises ("re-runs hourly in the worker … so a branch merged between
// restarts was invisible to project-scoped queries") only ever fired by the
// lottery of a queue row happening to exist at the exact tick instant.
// Measured 2026-07-16: a manual `adopt` left 384 Chroma docs unpatched, and
// the next tick logged nothing at all because the queue had drained.
//
// The registry stores RAW cwds rather than resolved repo roots on purpose:
// resolving costs a `git rev-parse` subprocess, and the recording site is the
// enqueue hot path (every tool call). Adoption resolves them lazily — it
// already calls resolveMainRepoPath() on every cwd it discovers.
import path from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { paths } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

const REGISTRY_BASENAME = 'known-cwds.json';

// Backstop against unbounded growth. Worktrees come and go; dead paths are
// pruned on write, so this only binds for a genuinely huge workspace count.
const MAX_CWDS = 500;

interface RegistryPayload {
  cwds: string[];
  updatedAt: string;
}

// Keyed by registry file path so tests can point at a temp data dir without
// leaking state between cases.
const caches = new Map<string, Set<string>>();

function registryPath(dataDirectory?: string): string {
  return path.join(dataDirectory ?? paths.dataDir(), 'state', REGISTRY_BASENAME);
}

function load(file: string): Set<string> {
  const cached = caches.get(file);
  if (cached) return cached;

  const set = new Set<string>();
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<RegistryPayload>;
      if (Array.isArray(parsed?.cwds)) {
        for (const cwd of parsed.cwds) {
          if (typeof cwd === 'string' && cwd.trim() !== '') set.add(cwd);
        }
      }
    }
  } catch (error: unknown) {
    // A corrupt registry must never break ingestion or adoption: it is a
    // derived convenience, rebuilt from the next cwds the worker sees.
    logger.debug('SYSTEM', 'Known-cwd registry unreadable, starting empty', {
      file,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  caches.set(file, set);
  return set;
}

function persist(file: string, set: Set<string>): void {
  // Prune paths that no longer exist (removed worktrees) so the file tracks
  // reality instead of accumulating every directory ever seen.
  for (const cwd of [...set]) {
    if (!existsSync(cwd)) set.delete(cwd);
  }

  const cwds = [...set].slice(-MAX_CWDS);
  const payload: RegistryPayload = { cwds, updatedAt: new Date().toISOString() };

  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8');
}

/**
 * Remember a cwd for later adoption passes. Cheap and idempotent: a cwd
 * already in the in-memory set costs one Set lookup, so this is safe to call
 * on every enqueued observation. Only a genuinely new cwd touches the disk.
 *
 * Best-effort by contract — never throws into the caller's path.
 */
export function recordCwd(cwd: string | null | undefined, dataDirectory?: string): void {
  if (typeof cwd !== 'string') return;
  const trimmed = cwd.trim();
  if (trimmed === '') return;

  const file = registryPath(dataDirectory);
  try {
    const set = load(file);
    if (set.has(trimmed)) return;
    set.add(trimmed);
    persist(file, set);
    logger.debug('SYSTEM', 'Recorded new cwd for worktree adoption', { cwd: trimmed });
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'Failed to record cwd in known-cwd registry', {
      cwd: trimmed,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Every cwd the worker has ingested that still exists on disk.
 */
export function listKnownCwds(dataDirectory?: string): string[] {
  const file = registryPath(dataDirectory);
  try {
    return [...load(file)].filter(cwd => existsSync(cwd));
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'Failed to read known-cwd registry', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export function resetKnownCwdRegistryCacheForTesting(): void {
  caches.clear();
}
