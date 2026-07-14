// IO discipline (see src/shared/hook-io.ts): this handler is PURE. It returns a
// HookResult and MUST NOT call process.stderr.write / process.stdout.write /
// console.* / process.exit. logger.* calls are DIAGNOSTIC; thrown errors are
// caught by hookCommand and routed through emitBlockingError.
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { executeWithWorkerFallback, isWorkerFallback } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { parseJsonArray } from '../../shared/timeline-formatting.js';
import { statSync } from 'fs';
import path from 'path';
import { shouldTrackProject } from '../../shared/should-track-project.js';
import { getProjectContext } from '../../utils/project-name.js';

const FILE_READ_GATE_MIN_BYTES = 1_500;

const FETCH_LOOKAHEAD_LIMIT = 40;

const DISPLAY_LIMIT = 15;
const MAX_FILE_CONTEXT_PATHS = 10;

const TYPE_ICONS: Record<string, string> = {
  decision: '\u2696\uFE0F',
  bugfix: '\uD83D\uDD34',
  feature: '\uD83D\uDFE3',
  refactor: '\uD83D\uDD04',
  discovery: '\uD83D\uDD35',
  change: '\u2705',
};

function compactTime(timeStr: string): string {
  return timeStr.toLowerCase().replace(' am', 'a').replace(' pm', 'p');
}

function formatTime(epoch: number): string {
  const date = new Date(epoch);
  return date.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatDate(epoch: number): string {
  const date = new Date(epoch);
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

interface ObservationRow {
  id: number;
  memory_session_id: string;
  title: string | null;
  type: string;
  created_at_epoch: number;
  files_read: string | null;
  files_modified: string | null;
}

function deduplicateObservations(
  observations: ObservationRow[],
  targetPath: string,
  displayLimit: number
): ObservationRow[] {
  // Content-dedup, NOT session-dedup: collapsing by memory_session_id kept only
  // the newest observation per session (the blandest "verification" wrap-up) and
  // dropped the decision-carrying bugfix/root-cause siblings. Dedup by normalized
  // title instead — collapse only exact re-captures, keep distinct observations.
  const seenTitles = new Set<string>();
  const deduped: ObservationRow[] = [];
  for (const obs of observations) {
    const titleKey = (obs.title ?? '').toLowerCase().replace(/\s+/g, ' ').trim() || `no-title-${obs.id}`;
    if (!seenTitles.has(titleKey)) {
      seenTitles.add(titleKey);
      deduped.push(obs);
    }
  }

  const scored = deduped.map(obs => {
    const filesRead = parseJsonArray(obs.files_read);
    const filesModified = parseJsonArray(obs.files_modified);
    const totalFiles = filesRead.length + filesModified.length;
    const normalizedTarget = targetPath.replace(/\\/g, '/');
    const inModified = filesModified.some(f => f.replace(/\\/g, '/') === normalizedTarget);

    let specificityScore = 0;
    if (inModified) specificityScore += 2;
    if (totalFiles <= 3) specificityScore += 2;
    else if (totalFiles <= 8) specificityScore += 1;

    return { obs, specificityScore };
  });

  scored.sort((a, b) => b.specificityScore - a.specificityScore);

  return scored.slice(0, displayLimit).map(s => s.obs);
}

function formatFileTimeline(
  observations: ObservationRow[],
  filePath: string,
  fileMtimeMs: number = 0
): string {
  const safePath = filePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const byDay = new Map<string, ObservationRow[]>();
  for (const obs of observations) {
    const day = formatDate(obs.created_at_epoch);
    if (!byDay.has(day)) {
      byDay.set(day, []);
    }
    byDay.get(day)!.push(obs);
  }

  const sortedDays = Array.from(byDay.entries()).sort((a, b) => {
    const aEpoch = Math.min(...a[1].map(o => o.created_at_epoch));
    const bEpoch = Math.min(...b[1].map(o => o.created_at_epoch));
    return aEpoch - bEpoch;
  });

  const now = new Date();
  const currentDate = now.toLocaleDateString('en-CA'); 
  const currentTime = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).toLowerCase().replace(' ', '');
  const currentTimezone = now.toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop();

  const lines: string[] = [
    `Current: ${currentDate} ${currentTime} ${currentTimezone}`,
    `This file has prior observations — supplementary context follows. The Read result below is the full requested section.`,
    `- **Need details on a past observation?** get_observations([IDs]) — ~300 tokens each.`,
    `- **Need a structural map first?** codegraph explore "${safePath}" — symbols and call paths, cheaper than re-reading.`,
  ];

  for (const [day, dayObservations] of sortedDays) {
    const chronological = [...dayObservations].sort((a, b) => a.created_at_epoch - b.created_at_epoch);
    lines.push(`### ${day}`);
    for (const obs of chronological) {
      const title = (obs.title || 'Untitled').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
      const icon = TYPE_ICONS[obs.type] || '\u2753';
      const time = compactTime(formatTime(obs.created_at_epoch));
      const staleSuffix = (fileMtimeMs > 0 && obs.created_at_epoch <= fileMtimeMs) ? ' \u26a0 may be stale (file edited since)' : '';
      lines.push(`${obs.id} ${time} ${icon} ${title}${staleSuffix}`);
    }
  }

  return lines.join('\n');
}

export const fileContextHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const toolInput = input.toolInput as Record<string, unknown> | undefined;
    const filePaths = Array.isArray(toolInput?.filePaths)
      ? (toolInput.filePaths as unknown[]).filter((p): p is string => typeof p === 'string').slice(0, MAX_FILE_CONTEXT_PATHS)
      : [];
    const filePath = toolInput?.file_path as string | undefined;
    const candidatePaths = filePaths.length > 0 ? filePaths : (filePath ? [filePath] : []);

    if (candidatePaths.length === 0) {
      return { continue: true, suppressOutput: true };
    }

    if (input.cwd && !shouldTrackProject(input.cwd)) {
      logger.debug('HOOK', 'Project excluded from tracking, skipping file context', { cwd: input.cwd });
      return { continue: true, suppressOutput: true };
    }

    const timelineResults = await Promise.allSettled(
      candidatePaths.map(candidatePath => buildFileContextTimeline(input, candidatePath))
    );
    const timelines: string[] = [];

    timelineResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        if (result.value) timelines.push(result.value);
        return;
      }
      logger.debug('HOOK', 'File context timeline lookup failed, skipping path', {
        filePath: candidatePaths[index],
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    });

    if (timelines.length === 0) {
      return { continue: true, suppressOutput: true };
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: timelines.join('\n\n---\n\n'),
        permissionDecision: 'allow',
      },
    };
  },
};

async function buildFileContextTimeline(input: NormalizedHookInput, filePath: string): Promise<string | null> {
  let fileMtimeMs = 0;
  try {
    const statPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(input.cwd || process.cwd(), filePath);
    const stat = statSync(statPath);
    if (!stat.isFile() || stat.size < FILE_READ_GATE_MIN_BYTES) {
      return null;
    }
    fileMtimeMs = stat.mtimeMs;
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    logger.debug('HOOK', 'File stat failed, proceeding with gate', { error: err instanceof Error ? err.message : String(err) });
  }

  const context = getProjectContext(input.cwd);
  const cwd = input.cwd || process.cwd();
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  const relativePath = path.relative(cwd, absolutePath).split(path.sep).join("/");

  // #2691 — PostToolUse stores whatever path form the observer recorded
  // (absolute tool-input path, or project-root-relative per the prompt). The
  // PreToolUse:Read query previously sent ONLY the cwd-relative form, so it
  // never matched absolute-path storage. Send both candidate forms (forward-
  // slashed, de-duped) as repeated `path` params so the key matches across
  // both events regardless of how the path was stored.
  const candidateQueryPaths = Array.from(new Set([
    absolutePath.split(path.sep).join("/"),
    relativePath,
  ].filter(Boolean)));
  const queryParams = new URLSearchParams();
  for (const candidate of candidateQueryPaths) {
    queryParams.append('path', candidate);
  }
  if (context.allProjects.length > 0) {
    queryParams.set('projects', context.allProjects.join(','));
  }
  queryParams.set('limit', String(FETCH_LOOKAHEAD_LIMIT));

  const result = await executeWithWorkerFallback<{ observations: ObservationRow[]; count: number }>(
    `/api/observations/by-file?${queryParams.toString()}`,
    'GET',
  );
  if (isWorkerFallback(result)) {
    return null;
  }
  if (!result || !Array.isArray((result as any).observations)) {
    logger.warn('HOOK', 'File context query returned malformed body, skipping', { filePath });
    return null;
  }
  const data = result;

  if (!data.observations || data.observations.length === 0) {
    return null;
  }

  // #1719 mtime gate: annotate, don't suppress. A merge/checkout bumps mtime past
  // every worktree observation, so suppressing here silenced merged feature-work.
  // Observations older than the file's last edit are now flagged stale in-place.
  const dedupedObservations = deduplicateObservations(data.observations, relativePath, DISPLAY_LIMIT);
  if (dedupedObservations.length === 0) {
    return null;
  }

  return formatFileTimeline(dedupedObservations, filePath, fileMtimeMs);
}
