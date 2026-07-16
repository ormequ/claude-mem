import { existsSync, readdirSync, rmSync, statSync } from 'fs';
import path from 'path';
import { smartToolsEnabled } from '../../shared/smart-tools.js';

export type ClaudeMemSkillSet = 'default' | 'compact' | 'full';

/**
 * Default set: the compact cross-runtime core plus the report/analysis skills.
 * Includes `knowledge-agent` (corpus Q&A) because this fork enhances its Q&A
 * path (`CLAUDE_MEM_OPENROUTER_QA_MODEL`) and shipping the tool without the
 * skill that surfaces it was inconsistent.
 */
export const DEFAULT_CLAUDE_MEM_SKILLS = [
  'mem-search',
  'smart-explore',
  'learn-codebase',
  'how-it-works',
  'timeline-report',
  'weekly-digests',
  'standup',
  'pathfinder',
  'knowledge-agent',
] as const;

/**
 * Compact set: memory retrieval core plus the situational tools worth a
 * permanent slot. `learn-codebase` was dropped — it brute-reads every file to
 * front-load context, which `codegraph` (queried on demand) makes dead weight
 * in an indexed repo. `pathfinder` (architecture audit before a refactor) took
 * its place: not "memory", but a heavy tool actually reached for.
 * `timeline-report` is the one narrative report kept — `weekly-digests` reads
 * the same whole-history data as serial per-week chapters, so shipping both
 * duplicates the same source in two formats.
 */
export const COMPACT_CLAUDE_MEM_SKILLS = [
  'knowledge-agent',
  'mem-search',
  'pathfinder',
  'timeline-report',
] as const;

export type SkillFilterResult = {
  filtered: boolean;
  set: ClaudeMemSkillSet;
  kept: string[];
  removed: string[];
};

/**
 * Resolve which skill set to install.
 *
 * `CLAUDE_MEM_SKILL_SET` = `default` | `compact` | `full` takes precedence.
 * Legacy `CLAUDE_MEM_INSTALL_ALL_SKILLS=true` still maps to `full`.
 * Unset (or an unrecognized value) → `default`.
 */
export function resolveClaudeMemSkillSet(): ClaudeMemSkillSet {
  const explicit = process.env.CLAUDE_MEM_SKILL_SET?.trim().toLowerCase();
  if (explicit === 'default' || explicit === 'compact' || explicit === 'full') {
    return explicit;
  }

  if (process.env.CLAUDE_MEM_INSTALL_ALL_SKILLS?.trim().toLowerCase() === 'true') {
    return 'full';
  }

  return 'default';
}

/**
 * The allowlist of skill names for a set, or `null` for `full` (keep every
 * bundled skill without filtering).
 */
export function claudeMemSkillAllowlist(
  set: ClaudeMemSkillSet = resolveClaudeMemSkillSet(),
): readonly string[] | null {
  switch (set) {
    case 'full':
      return null;
    case 'compact':
      return COMPACT_CLAUDE_MEM_SKILLS;
    case 'default':
    default:
      // FORK: smart-explore is built entirely on the smart_* tools, so it is
      // dead weight once they are disabled. `full` stays unfiltered by contract;
      // `compact` never shipped it.
      return smartToolsEnabled()
        ? DEFAULT_CLAUDE_MEM_SKILLS
        : DEFAULT_CLAUDE_MEM_SKILLS.filter(skill => skill !== 'smart-explore');
  }
}

/**
 * Parse the optional extra bundled skills without changing their configured
 * order. Empty entries and repeats are intentionally ignored.
 */
export function resolveClaudeMemExtraSkills(): readonly string[] {
  const configured = process.env.CLAUDE_MEM_INSTALL_EXTRA_SKILLS ?? '';
  return [...new Set(
    configured.split(',').map((skill) => skill.trim()).filter(Boolean),
  )];
}

function listBundledSkillNames(skillsDirectory: string): string[] {
  return readdirSync(skillsDirectory)
    .sort()
    .filter((entry) => statSync(path.join(skillsDirectory, entry)).isDirectory());
}

/**
 * Resolve the configured preset plus validated extras for a bundled skills
 * directory. `null` means every bundled skill should be installed.
 */
export function resolveClaudeMemSkillNames(skillsDirectory: string): readonly string[] | null {
  const set = resolveClaudeMemSkillSet();
  const extras = resolveClaudeMemExtraSkills();
  const available = listBundledSkillNames(skillsDirectory);
  const availableSet = new Set(available);
  const unknown = extras.filter((skill) => !availableSet.has(skill));

  if (unknown.length > 0) {
    const label = unknown.length === 1 ? 'skill' : 'skills';
    throw new Error(
      `Unknown Claude-Mem extra ${label}: ${unknown.join(', ')}. Available bundled skills: ${available.join(', ')}`,
    );
  }

  const preset = claudeMemSkillAllowlist(set);
  return preset === null ? null : [...new Set([...preset, ...extras])];
}

/** Back-compat helper: true when the resolved set keeps every bundled skill. */
export function shouldInstallAllClaudeMemSkills(): boolean {
  return resolveClaudeMemSkillSet() === 'full';
}

export function filterClaudeMemSkillsDirectory(skillsDirectory: string): SkillFilterResult {
  const set = resolveClaudeMemSkillSet();

  if (!existsSync(skillsDirectory)) {
    return { filtered: false, set, kept: [], removed: [] };
  }

  const allowlist = resolveClaudeMemSkillNames(skillsDirectory);
  if (allowlist === null) {
    return { filtered: false, set, kept: [], removed: [] };
  }

  const allowed = new Set(allowlist);
  const kept: string[] = [];
  const removed: string[] = [];

  for (const entry of readdirSync(skillsDirectory).sort()) {
    const entryPath = path.join(skillsDirectory, entry);
    if (!statSync(entryPath).isDirectory()) {
      continue;
    }

    if (allowed.has(entry)) {
      kept.push(entry);
      continue;
    }

    rmSync(entryPath, { recursive: true, force: true });
    removed.push(entry);
  }

  return { filtered: true, set, kept, removed };
}

export function filterClaudeMemSkillsInPluginRoot(pluginRoot: string): SkillFilterResult {
  return filterClaudeMemSkillsDirectory(path.join(pluginRoot, 'skills'));
}
