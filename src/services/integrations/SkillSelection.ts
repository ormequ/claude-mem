import { existsSync, readdirSync, rmSync, statSync } from 'fs';
import path from 'path';

export const DEFAULT_CLAUDE_MEM_SKILLS = [
  'mem-search',
  'learn-codebase',
  'how-it-works',
  'timeline-report',
  'weekly-digests',
  'standup',
  'pathfinder',
] as const;

export type SkillFilterResult = {
  filtered: boolean;
  kept: string[];
  removed: string[];
};

export function shouldInstallAllClaudeMemSkills(): boolean {
  return process.env.CLAUDE_MEM_INSTALL_ALL_SKILLS?.trim().toLowerCase() === 'true';
}

export function filterClaudeMemSkillsDirectory(skillsDirectory: string): SkillFilterResult {
  if (shouldInstallAllClaudeMemSkills() || !existsSync(skillsDirectory)) {
    return { filtered: false, kept: [], removed: [] };
  }

  const allowed = new Set<string>(DEFAULT_CLAUDE_MEM_SKILLS);
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

  return { filtered: true, kept, removed };
}
