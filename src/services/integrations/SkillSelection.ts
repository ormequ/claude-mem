import { existsSync, readdirSync, rmSync, statSync } from 'fs';
import path from 'path';

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
 * Compact set: only the essentials — memory search, codebase priming, and the
 * corpus Q&A agent.
 */
export const COMPACT_CLAUDE_MEM_SKILLS = [
  'knowledge-agent',
  'mem-search',
  'learn-codebase',
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
      return DEFAULT_CLAUDE_MEM_SKILLS;
  }
}

/** Back-compat helper: true when the resolved set keeps every bundled skill. */
export function shouldInstallAllClaudeMemSkills(): boolean {
  return resolveClaudeMemSkillSet() === 'full';
}

export function filterClaudeMemSkillsDirectory(skillsDirectory: string): SkillFilterResult {
  const set = resolveClaudeMemSkillSet();
  const allowlist = claudeMemSkillAllowlist(set);

  if (allowlist === null || !existsSync(skillsDirectory)) {
    return { filtered: false, set, kept: [], removed: [] };
  }

  const allowed = new Set<string>(allowlist);
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
