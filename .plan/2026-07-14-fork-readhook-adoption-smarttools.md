# Fork Scope: Read-Hook Ranking/Staleness/Header + Periodic Adoption + Smart-Tools Flag

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve the fork's `PreToolUse:Read` hook (value-aware ranking, honest staleness marker, minimal header), close the adoption gap between worker restarts, and add an off-switch for the `smart_*` MCP tools.

**Architecture:** All new logic lives in fork-owned files that upstream does not have (`file-context-ranking.ts`, `file-staleness.ts`, `AdoptionScheduler.ts`, `smart-tools.ts`); upstream-hot files get one-line import/call touch points only. No schema changes, no worker API changes — the by-file endpoint already returns `concepts` because `getObservationsByFilePath` does `SELECT o.*` and `handleGetObservationsByFile` passes rows through verbatim.

**Tech Stack:** TypeScript, Bun (runtime + `bun:test`), Express worker, SQLite.

## Global Constraints

- **Never** use observation `type` as a sort key or filter in ranking — simulation-verified to bury the killer revert case (#24717, `type=change`). Concepts boost is **additive to the score only**.
- Display cap stays **15** (`DISPLAY_LIMIT`); fetch lookahead stays **40** (`FETCH_LOOKAHEAD_LIMIT`). Caps of 5–7 drop killer observations (verified 2026-07-11).
- Content-dedup by normalized title stays exactly as-is (replacing it with session-dedup regressed; see `docs/bug-fixes/2026-07-11-read-hook-delivery-reliability.md`).
- `permissionDecision: 'allow'` is settled — do not introduce deny/block behavior (see FORK_NOTES "Upstream baseline").
- Display order inside the timeline stays **chronological** (it is a timeline); ranking decides only *which* observations survive the cap.
- Run per-task: `bun run typecheck` and the task's test file. Commit after each task.
- Final verification: fork checklist in `FORK_NOTES.md` ("Upgrade checklist" section) + killer smoke-reads (below).
- Deploy gotcha: after `npm run build-and-sync`, verify the *installed* worker actually contains the change (grep the built `worker-service.cjs` in the marketplace/PLUS cache for a marker string) — a stale cache copy has silently shadowed deploys before.

---

### Task 1: Fork-owned ranking module with concepts boost

**Files:**
- Create: `src/cli/handlers/file-context-ranking.ts`
- Modify: `src/cli/handlers/file-context.ts` (delete `deduplicateObservations` lines 54–91, add import + call; extend `ObservationRow`)
- Test: `tests/hooks/file-context-ranking.test.ts` (new)

**Interfaces:**
- Consumes: nothing from other tasks. Uses `parseJsonArray` from `src/shared/timeline-formatting.js` (already used by `file-context.ts`).
- Produces: `rankFileObservations<T extends RankableObservation>(observations: T[], targetPath: string, displayLimit: number): T[]` — Task 2/3 leave the call site untouched.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/hooks/file-context-ranking.test.ts
import { describe, it, expect } from 'bun:test';
import { rankFileObservations, type RankableObservation } from '../../src/cli/handlers/file-context-ranking.js';

const TARGET = 'resources/js/Pages/Dev/Gallery.vue';

function obs(over: Partial<RankableObservation> & { id: number }): RankableObservation {
  return {
    memory_session_id: 's1',
    title: `Observation ${over.id}`,
    type: 'discovery',
    created_at_epoch: 1_700_000_000_000 + over.id * 60_000,
    files_read: null,
    files_modified: JSON.stringify([TARGET]),
    concepts: JSON.stringify(['what-changed']),
    ...over,
  };
}

describe('rankFileObservations', () => {
  it('collapses exact re-captures by normalized title, keeps distinct titles', () => {
    const rows = [
      obs({ id: 1, title: 'Fixed the   thing' }),
      obs({ id: 2, title: 'fixed the thing' }), // same after normalization
      obs({ id: 3, title: 'Another finding' }),
    ];
    const ranked = rankFileObservations(rows, TARGET, 15);
    expect(ranked.map(o => o.id).sort()).toEqual([1, 3]);
  });

  it('keeps rows with null titles distinct (no accidental collapse)', () => {
    const rows = [obs({ id: 1, title: null }), obs({ id: 2, title: null })];
    expect(rankFileObservations(rows, TARGET, 15)).toHaveLength(2);
  });

  it('boosts decision-carrying concepts over chronicle noise under the cap (killer #24717 class)', () => {
    // 16 newer chronicle entries + 1 old revert with a decision concept.
    // Without the boost the revert would be squeezed out of the top 15
    // when specificity ties.
    const chronicle = Array.from({ length: 16 }, (_, i) =>
      obs({ id: 100 + i, concepts: JSON.stringify(['what-changed']) }));
    const revert = obs({
      id: 1,
      type: 'change',
      title: 'Gallery Close Button Position Reverted',
      concepts: JSON.stringify(['decision', 'what-changed']),
      created_at_epoch: 1_600_000_000_000, // oldest of all
    });
    const ranked = rankFileObservations([...chronicle, revert], TARGET, 15);
    expect(ranked.map(o => o.id)).toContain(1);
  });

  it('never uses type as a filter: low-priority type with boosted concept survives', () => {
    const ranked = rankFileObservations(
      [obs({ id: 1, type: 'change', concepts: JSON.stringify(['gotcha']) })],
      TARGET, 15,
    );
    expect(ranked).toHaveLength(1);
  });

  it('prefers observations that modified the target file with a small file set', () => {
    const specific = obs({ id: 1, files_modified: JSON.stringify([TARGET]) });
    const broad = obs({
      id: 2,
      files_modified: JSON.stringify(Array.from({ length: 12 }, (_, i) => `f${i}.ts`)),
      files_read: JSON.stringify([TARGET]),
    });
    const filler = Array.from({ length: 14 }, (_, i) => obs({ id: 100 + i }));
    const ranked = rankFileObservations([broad, specific, ...filler], TARGET, 15);
    expect(ranked.map(o => o.id)).toContain(1);
  });

  it('respects the display limit', () => {
    const rows = Array.from({ length: 40 }, (_, i) => obs({ id: i + 1, title: `t${i}` }));
    expect(rankFileObservations(rows, TARGET, 15)).toHaveLength(15);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/hooks/file-context-ranking.test.ts`
Expected: FAIL — `Cannot find module '../../src/cli/handlers/file-context-ranking.js'`

- [ ] **Step 3: Create the ranking module**

```typescript
// src/cli/handlers/file-context-ranking.ts
//
// FORK-OWNED (no upstream counterpart): selection/ranking for the
// PreToolUse:Read per-file timeline. Kept out of file-context.ts so upstream
// merges touch at most the one import + one call site there.
import { parseJsonArray } from '../../shared/timeline-formatting.js';

export interface RankableObservation {
  id: number;
  memory_session_id: string;
  title: string | null;
  type: string;
  created_at_epoch: number;
  files_read: string | null;
  files_modified: string | null;
  concepts: string | null;
}

// Concepts the observer tags at capture time that mark decision-carrying
// content. Additive score boost ONLY — never a sort key, never a filter:
// type/priority-based selection is simulation-proven to bury the
// "deliberate revert" class (#24717, type=change).
const BOOST_CONCEPTS = new Set(['decision', 'gotcha', 'trade-off', 'problem-solution']);
const CONCEPT_BOOST = 2;

export function rankFileObservations<T extends RankableObservation>(
  observations: T[],
  targetPath: string,
  displayLimit: number,
): T[] {
  // Content-dedup, NOT session-dedup: collapsing by memory_session_id kept only
  // the newest observation per session (the blandest "verification" wrap-up) and
  // dropped the decision-carrying bugfix/root-cause siblings. Dedup by normalized
  // title instead — collapse only exact re-captures, keep distinct observations.
  const seenTitles = new Set<string>();
  const deduped: T[] = [];
  for (const obs of observations) {
    const titleKey = (obs.title ?? '').toLowerCase().replace(/\s+/g, ' ').trim() || `no-title-${obs.id}`;
    if (!seenTitles.has(titleKey)) {
      seenTitles.add(titleKey);
      deduped.push(obs);
    }
  }

  const normalizedTarget = targetPath.replace(/\\/g, '/');
  const scored = deduped.map(obs => {
    const filesRead = parseJsonArray(obs.files_read);
    const filesModified = parseJsonArray(obs.files_modified);
    const totalFiles = filesRead.length + filesModified.length;
    const inModified = filesModified.some(f => f.replace(/\\/g, '/') === normalizedTarget);

    let score = 0;
    if (inModified) score += 2;
    if (totalFiles <= 3) score += 2;
    else if (totalFiles <= 8) score += 1;

    if (parseJsonArray(obs.concepts).some(c => BOOST_CONCEPTS.has(c))) {
      score += CONCEPT_BOOST;
    }

    return { obs, score };
  });

  // Stable sort: ties keep the incoming order (newest-first from the by-file
  // query), so recency remains the tiebreaker.
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, displayLimit).map(s => s.obs);
}
```

- [ ] **Step 4: Wire it into file-context.ts**

In `src/cli/handlers/file-context.ts`:

1. Add import next to the existing ones:

```typescript
import { rankFileObservations } from './file-context-ranking.js';
```

2. Delete the whole `deduplicateObservations` function (currently lines 54–91, from `function deduplicateObservations(` through its closing `}`).

3. Extend the local `ObservationRow` interface with the concepts field (the by-file endpoint already returns it — `SELECT o.*`):

```typescript
interface ObservationRow {
  id: number;
  memory_session_id: string;
  title: string | null;
  type: string;
  created_at_epoch: number;
  files_read: string | null;
  files_modified: string | null;
  concepts: string | null;
}
```

4. Replace the call site (inside `buildFileContextTimeline`, currently line 255):

```typescript
  const dedupedObservations = rankFileObservations(data.observations, relativePath, DISPLAY_LIMIT);
```

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test tests/hooks/file-context-ranking.test.ts tests/hooks/file-context.test.ts && bun run typecheck`
Expected: PASS. If `tests/hooks/file-context.test.ts` references `deduplicateObservations` directly, update those references to `rankFileObservations` from the new module (behavior for existing cases is unchanged: same dedup, same specificity scoring; concepts absent ⇒ no boost).

- [ ] **Step 6: Commit**

```bash
git add src/cli/handlers/file-context-ranking.ts src/cli/handlers/file-context.ts tests/hooks/file-context-ranking.test.ts tests/hooks/file-context.test.ts
git commit -m "feat(read-hook): extract ranking to fork module, boost decision-carrying concepts"
```

---

### Task 2: Header trim (4 boilerplate lines → 2)

**Files:**
- Modify: `src/cli/handlers/file-context.ts` (`formatFileTimeline`, currently lines 123–128)
- Test: `tests/hooks/file-context.test.ts` (update header assertions if any)

**Interfaces:**
- Consumes: nothing new.
- Produces: no signature changes.

- [ ] **Step 1: Replace the header block**

In `formatFileTimeline`, the `lines` initialization currently is (the last line was
re-pointed from `smart_outline` to `codegraph explore` in commit `a1e7180f`):

```typescript
  const lines: string[] = [
    `Current: ${currentDate} ${currentTime} ${currentTimezone}`,
    `This file has prior observations — supplementary context follows. The Read result below is the full requested section.`,
    `- **Need details on a past observation?** get_observations([IDs]) — ~300 tokens each.`,
    `- **Need a structural map first?** codegraph explore "${safePath}" — symbols and call paths, cheaper than re-reading.`,
  ];
```

Replace with the two-line version below. Dropping the codegraph hint that
`a1e7180f` just added is deliberate, not an oversight: the transcript audit
showed per-injection tool hints are almost never acted on, and the user's
global CLAUDE.md already mandates codegraph-first in indexed repos, so the
hint is redundant in every session that could use it. Folds the fetch hint
into one line:

```typescript
  const lines: string[] = [
    `Current: ${currentDate} ${currentTime} ${currentTimezone}`,
    `Prior observations for this file (the Read result below is the full requested section). Details: get_observations([IDs]) — ~300 tokens each.`,
  ];
```

Then remove the now-unused `safePath` variable at the top of `formatFileTimeline` (currently line 98) — typecheck will flag it otherwise.

- [ ] **Step 2: Update tests, run, verify**

Run: `grep -n "smart_outline\|supplementary context" tests/hooks/file-context.test.ts`
Update any assertion matching the old header lines to the new single line.
Run: `bun test tests/hooks/file-context.test.ts && bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/cli/handlers/file-context.ts tests/hooks/file-context.test.ts
git commit -m "feat(read-hook): trim injection header, drop smart_outline hint"
```

---

### Task 3: Staleness by git content-change instead of mtime

**Files:**
- Create: `src/cli/handlers/file-staleness.ts`
- Modify: `src/cli/handlers/file-context.ts` (`buildFileContextTimeline`)
- Test: `tests/hooks/file-staleness.test.ts` (new)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `getContentStaleThresholdMs(absPath: string, cwd: string, mtimeMs: number): number` — epoch ms; observations with `created_at_epoch <= threshold` are marked stale.

**Why:** mtime as the stale trigger marks ~90%+ of entries after any merge/checkout (mtime bumps on every checkout even when content is identical) — the marker is wallpaper. `git log -1` on the path gives the last *content* change; a merge that didn't touch the file leaves it unchanged.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/hooks/file-staleness.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { getContentStaleThresholdMs } from '../../src/cli/handlers/file-staleness.js';

const COMMIT_EPOCH_S = 1_700_000_000; // fixed past commit time
let repo: string;

function git(args: string[], env: Record<string, string> = {}) {
  execFileSync('git', args, {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: `${COMMIT_EPOCH_S} +0000`,
      GIT_COMMITTER_DATE: `${COMMIT_EPOCH_S} +0000`,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'stale-test-'));
  git(['init', '-q']);
  writeFileSync(join(repo, 'a.txt'), 'committed content\n');
  git(['add', 'a.txt']);
  git(['commit', '-q', '-m', 'initial']);
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('getContentStaleThresholdMs', () => {
  it('returns last commit time for a clean tracked file, ignoring a newer mtime', () => {
    const abs = join(repo, 'a.txt');
    const now = Date.now();
    utimesSync(abs, now / 1000, now / 1000); // simulate checkout/merge bumping mtime
    const threshold = getContentStaleThresholdMs(abs, repo, now);
    expect(threshold).toBe(COMMIT_EPOCH_S * 1000);
  });

  it('falls back to mtime for a dirty file', () => {
    const abs = join(repo, 'a.txt');
    writeFileSync(abs, 'uncommitted edit\n');
    const mtime = 1_800_000_000_000;
    expect(getContentStaleThresholdMs(abs, repo, mtime)).toBe(mtime);
    // restore clean state for other tests
    git(['checkout', '-q', '--', 'a.txt']);
  });

  it('falls back to mtime for an untracked file', () => {
    const abs = join(repo, 'new.txt');
    writeFileSync(abs, 'untracked\n');
    const mtime = 1_800_000_000_000;
    expect(getContentStaleThresholdMs(abs, repo, mtime)).toBe(mtime);
  });

  it('falls back to mtime outside a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'norepo-'));
    const abs = join(dir, 'f.txt');
    writeFileSync(abs, 'x');
    const mtime = 1_800_000_000_000;
    expect(getContentStaleThresholdMs(abs, dir, mtime)).toBe(mtime);
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/hooks/file-staleness.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```typescript
// src/cli/handlers/file-staleness.ts
//
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
```

- [ ] **Step 4: Wire into buildFileContextTimeline**

In `src/cli/handlers/file-context.ts`:

1. Add import:

```typescript
import { getContentStaleThresholdMs } from './file-staleness.js';
```

2. In `buildFileContextTimeline`, replace the final `return` (currently line 260):

```typescript
  const staleThresholdMs = fileMtimeMs > 0
    ? getContentStaleThresholdMs(absolutePath, cwd, fileMtimeMs)
    : 0;
  return formatFileTimeline(dedupedObservations, filePath, staleThresholdMs);
```

(`formatFileTimeline`'s third parameter keeps its comparison semantics: entries with `created_at_epoch <= threshold` get the `⚠ may be stale` suffix. Rename the parameter from `fileMtimeMs` to `staleThresholdMs` for honesty; it is used only in the `staleSuffix` expression, currently line 137.)

Note: the git calls run only when the by-file query returned observations (rare path), not on every Read.

- [ ] **Step 5: Run tests, typecheck, measure latency**

Run: `bun test tests/hooks/file-staleness.test.ts tests/hooks/file-context.test.ts && bun run typecheck`
Expected: PASS

Latency check (informational): in a large repo, `time git log -1 --format=%ct -- <file>` — expect ≤ ~30ms warm. If it exceeds ~50ms on real hook runs, flag it in the PR notes rather than adding caching speculatively.

- [ ] **Step 6: Commit**

```bash
git add src/cli/handlers/file-staleness.ts src/cli/handlers/file-context.ts tests/hooks/file-staleness.test.ts
git commit -m "feat(read-hook): stale marker keyed to git content change, not mtime"
```

---

### Task 4: Periodic worktree-adoption rescan

**Files:**
- Create: `src/services/infrastructure/AdoptionScheduler.ts`
- Modify: `src/services/worker-service.ts` (one call after the existing startup adoption block, currently lines ~475–492)
- Test: `tests/services/infrastructure/adoption-scheduler.test.ts` (new)

**Interfaces:**
- Consumes: `adoptMergedWorktreesForAllKnownRepos` from `./WorktreeAdoption.js` (existing).
- Produces: `startPeriodicAdoption(intervalMs?: number, runAdoption?: () => Promise<unknown>): NodeJS.Timeout`

**Why:** adoption currently runs once at worker startup + manual `adopt` CLI. The worker lives for weeks, so a branch merged between restarts leaves its observations invisible to project-scoped queries until someone remembers the command.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/services/infrastructure/adoption-scheduler.test.ts
import { describe, it, expect } from 'bun:test';
import { startPeriodicAdoption } from '../../../src/services/infrastructure/AdoptionScheduler.js';

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('startPeriodicAdoption', () => {
  it('invokes the adoption runner on each interval', async () => {
    let calls = 0;
    const timer = startPeriodicAdoption(10, async () => { calls++; return []; });
    await tick(35);
    clearInterval(timer);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('skips ticks while a previous run is still in flight', async () => {
    let calls = 0;
    const timer = startPeriodicAdoption(10, async () => {
      calls++;
      await tick(50); // longer than several intervals
      return [];
    });
    await tick(45);
    clearInterval(timer);
    expect(calls).toBe(1);
  });

  it('keeps ticking after a runner failure', async () => {
    let calls = 0;
    const timer = startPeriodicAdoption(10, async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return [];
    });
    await tick(35);
    clearInterval(timer);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/services/infrastructure/adoption-scheduler.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```typescript
// src/services/infrastructure/AdoptionScheduler.ts
//
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
```

- [ ] **Step 4: Wire into worker startup**

In `src/services/worker-service.ts`, directly after the existing startup adoption block (the `adoptMergedWorktreesForAllKnownRepos({}).then(...)` chain ending with `.catch(...)`, currently lines ~476–492), add:

```typescript
      startPeriodicAdoption();
```

and add the import at the top of the file next to the `WorktreeAdoption` import:

```typescript
import { startPeriodicAdoption } from './infrastructure/AdoptionScheduler.js';
```

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test tests/services/infrastructure/adoption-scheduler.test.ts && bun run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/infrastructure/AdoptionScheduler.ts src/services/worker-service.ts tests/services/infrastructure/adoption-scheduler.test.ts
git commit -m "feat(adoption): hourly background rescan of merged worktrees"
```

---

### Task 5: `CLAUDE_MEM_SMART_TOOLS` off-switch

**Files:**
- Create: `src/shared/smart-tools.ts`
- Modify: `src/servers/mcp-server.ts` (ListTools handler ~line 881 and CallTool lookup ~line 891)
- Modify: `src/services/integrations/SkillSelection.ts` (`claudeMemSkillAllowlist`)
- Test: `tests/shared/smart-tools.test.ts` (new), `tests/integration/skill-selection.test.ts` (extend)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `smartToolsEnabled(env?: NodeJS.ProcessEnv): boolean`, `SMART_TOOL_NAMES: ReadonlySet<string>`

**Why:** the fork's users prefer codegraph/LSP for code structure; `smart_search`/`smart_unfold`/`smart_outline` occupy MCP tool-list context in every session with no way to opt out. Default stays **enabled** (upstream parity); disabling also drops the `smart-explore` skill (built entirely on these tools) from the default skill set.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/shared/smart-tools.test.ts
import { describe, it, expect } from 'bun:test';
import { smartToolsEnabled, SMART_TOOL_NAMES } from '../../src/shared/smart-tools.js';

describe('smartToolsEnabled', () => {
  it('defaults to enabled', () => {
    expect(smartToolsEnabled({})).toBe(true);
  });
  it('disables on "false" and "0" (case/space-insensitive)', () => {
    expect(smartToolsEnabled({ CLAUDE_MEM_SMART_TOOLS: 'false' })).toBe(false);
    expect(smartToolsEnabled({ CLAUDE_MEM_SMART_TOOLS: ' FALSE ' })).toBe(false);
    expect(smartToolsEnabled({ CLAUDE_MEM_SMART_TOOLS: '0' })).toBe(false);
  });
  it('stays enabled for any other value', () => {
    expect(smartToolsEnabled({ CLAUDE_MEM_SMART_TOOLS: 'true' })).toBe(true);
    expect(smartToolsEnabled({ CLAUDE_MEM_SMART_TOOLS: '' })).toBe(true);
  });
  it('names exactly the three smart tools', () => {
    expect([...SMART_TOOL_NAMES].sort()).toEqual(['smart_outline', 'smart_search', 'smart_unfold']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/shared/smart-tools.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the helper**

```typescript
// src/shared/smart-tools.ts
//
// FORK-OWNED: opt-out switch for the tree-sitter smart_* MCP tools.
// CLAUDE_MEM_SMART_TOOLS=false|0 removes them from MCP registration and
// drops the smart-explore skill (which is built on them) from the default
// skill set. Default is enabled — upstream parity.
export const SMART_TOOL_NAMES: ReadonlySet<string> = new Set([
  'smart_search',
  'smart_unfold',
  'smart_outline',
]);

export function smartToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CLAUDE_MEM_SMART_TOOLS?.trim().toLowerCase();
  return raw !== 'false' && raw !== '0';
}
```

- [ ] **Step 4: Filter MCP registration**

In `src/servers/mcp-server.ts`:

1. Add import near the other shared imports:

```typescript
import { smartToolsEnabled, SMART_TOOL_NAMES } from '../shared/smart-tools.js';
```

2. Immediately after the `const tools = [ ... ];` array closes (it starts at ~line 449), add:

```typescript
// FORK: CLAUDE_MEM_SMART_TOOLS=false removes the tree-sitter tools from
// registration entirely (codegraph/LSP setups don't want them in context).
const enabledTools = smartToolsEnabled()
  ? tools
  : tools.filter(tool => !SMART_TOOL_NAMES.has(tool.name));
```

3. In the `ListToolsRequestSchema` handler (~line 881), change `tools.map(...)` to `enabledTools.map(...)`.

4. In the `CallToolRequestSchema` handler (~line 891), change `tools.find(...)` to `enabledTools.find(...)` (a disabled tool must fail the call, not just hide from the list).

- [ ] **Step 5: Drop smart-explore from the default skill set when disabled**

In `src/services/integrations/SkillSelection.ts`, add the import:

```typescript
import { smartToolsEnabled } from '../../shared/smart-tools.js';
```

and change the `default` branch of `claudeMemSkillAllowlist`:

```typescript
    case 'default':
    default:
      return smartToolsEnabled()
        ? DEFAULT_CLAUDE_MEM_SKILLS
        : DEFAULT_CLAUDE_MEM_SKILLS.filter(skill => skill !== 'smart-explore');
```

(`compact` and `full` are untouched: compact never shipped smart-explore; `full` means "everything, no filtering" by contract.)

Add to `tests/integration/skill-selection.test.ts` a case following that file's existing env-manipulation pattern:

```typescript
it('drops smart-explore from the default set when smart tools are disabled', () => {
  process.env.CLAUDE_MEM_SMART_TOOLS = 'false';
  delete process.env.CLAUDE_MEM_SKILL_SET;
  const allowlist = claudeMemSkillAllowlist();
  expect(allowlist).not.toBeNull();
  expect(allowlist).not.toContain('smart-explore');
  expect(allowlist).toContain('mem-search');
  delete process.env.CLAUDE_MEM_SMART_TOOLS;
});
```

- [ ] **Step 6: Run tests and typecheck**

Run: `bun test tests/shared/smart-tools.test.ts tests/integration/skill-selection.test.ts && bun run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/shared/smart-tools.ts src/servers/mcp-server.ts src/services/integrations/SkillSelection.ts tests/shared/smart-tools.test.ts tests/integration/skill-selection.test.ts
git commit -m "feat(mcp): CLAUDE_MEM_SMART_TOOLS=false disables smart_* tools and smart-explore skill"
```

---

### Task 6: FORK_NOTES documentation

**Files:**
- Modify: `FORK_NOTES.md`

- [ ] **Step 1: Document the new fork deltas**

Append to the "Local fixes carried by the fork" list:

```markdown
- `PreToolUse:Read` ranking lives in fork-owned `src/cli/handlers/file-context-ranking.ts`:
  content-dedup (unchanged) + specificity score + additive boost for
  decision-carrying concepts (`decision`, `gotcha`, `trade-off`,
  `problem-solution`). Type is never a sort key or filter (simulation-verified
  to bury the deliberate-revert class). Display cap stays 15.
- The `⚠ may be stale` marker is keyed to the file's last *content* change
  (`git log -1 --format=%ct -- <path>`, mtime fallback for dirty/untracked/
  non-git) instead of raw mtime — a merge/checkout no longer marks every
  entry stale (`src/cli/handlers/file-staleness.ts`).
- The read-hook injection header is two lines (`get_observations` hint only;
  the `smart_outline` hint is gone).
- Merged-worktree adoption re-runs hourly in the worker
  (`src/services/infrastructure/AdoptionScheduler.ts`), not just at startup.
- `CLAUDE_MEM_SMART_TOOLS=false|0` removes `smart_search`/`smart_unfold`/
  `smart_outline` from MCP registration and drops `smart-explore` from the
  default skill set. Default: enabled (upstream parity).
```

- [ ] **Step 2: Extend the upgrade checklist test list**

In the "Upgrade checklist" section, extend the fork-focused test command with the new files:

```
tests/hooks/file-context-ranking.test.ts tests/hooks/file-staleness.test.ts tests/services/infrastructure/adoption-scheduler.test.ts tests/shared/smart-tools.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add FORK_NOTES.md
git commit -m "docs(fork-notes): record read-hook ranking/staleness, adoption timer, smart-tools flag"
```

---

### Task 7: Build, deploy, end-to-end verification

- [ ] **Step 1: Full fork test pass**

Run: `bun run typecheck && bun test tests/telemetry/consent.test.ts tests/integration/skill-selection.test.ts tests/integration/opencode-installer.test.ts tests/install-non-tty.test.ts tests/services/sqlite/observations-by-file-merged-scoping.test.ts tests/hooks/file-context.test.ts tests/hooks/file-context-ranking.test.ts tests/hooks/file-staleness.test.ts tests/services/infrastructure/adoption-scheduler.test.ts tests/shared/smart-tools.test.ts`
Expected: PASS

- [ ] **Step 2: Build and deploy**

Run: `npm run build-and-sync`
Then verify the deployed bundle actually contains the change (cache shadowing has silently reverted deploys before):
Run: `grep -c "file-context-ranking\|getContentStaleThresholdMs" "$HOME/.claude/plugins/marketplaces/ormequ/plugin/scripts/worker-service.cjs"`
Expected: ≥ 1 (adjust the path if the installed marketplace root differs; see FORK_NOTES install topology).

- [ ] **Step 3: Killer smoke-reads (real DB, kedo)**

From a session in `/Users/ormequ/Development/kedo` (or by invoking the hook manually with `bun <installed>/worker-service.cjs hook claude-code file-context` and a Read payload for these paths):
- Read `app/Services/Bitrix24/AbsencesImporter.php` → timeline must include observations #25165 and #25175.
- Read `resources/js/Pages/Dev/Gallery.vue` → timeline must include #24717.
- A file with git-committed content and no edits since the last commit must show entries created after that commit **without** the stale marker.

- [ ] **Step 4: User-side config (manual, not code)**

Add to the claude-mem env file (`~/.claude-mem/.env` or wherever `CLAUDE_MEM_ENV_FILE` points): `CLAUDE_MEM_SMART_TOOLS=false`, then reinstall/re-sync skills so the default set drops smart-explore.
