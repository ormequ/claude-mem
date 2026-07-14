// FORK-OWNED: periodic re-run of merged-worktree adoption. Upstream runs
// adoption once at worker startup (worker-service.ts) plus a manual `adopt`
// CLI. The worker process lives for weeks, so a branch merged between
// restarts left its worktree observations invisible to parent-project
// queries until the next restart. This timer closes that gap.
import { adoptMergedWorktreesForAllKnownRepos } from './WorktreeAdoption.js';
import { logger } from '../../utils/logger.js';

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // hourly

type AdoptionRunner = () => Promise<unknown>;

export function startPeriodicAdoption(
  intervalMs: number = DEFAULT_INTERVAL_MS,
  runAdoption: AdoptionRunner = () => adoptMergedWorktreesForAllKnownRepos({}),
): NodeJS.Timeout {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    Promise.resolve()
      .then(runAdoption)
      .then(result => {
        if (Array.isArray(result) && result.length > 0) {
          logger.debug('SYSTEM', 'Periodic worktree adoption pass completed', { repos: result.length });
        }
      })
      .catch(err => {
        logger.warn('SYSTEM', 'Periodic worktree adoption failed', {},
          err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => { inFlight = false; });
  }, intervalMs);
  timer.unref?.();
  return timer;
}
