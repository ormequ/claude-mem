import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  DEFAULT_CLAUDE_MEM_SKILLS,
  filterClaudeMemSkillsDirectory,
  shouldInstallAllClaudeMemSkills,
} from '../../src/services/integrations/SkillSelection';

const tempDir = join(tmpdir(), `claude-mem-skill-selection-${process.pid}`);

function writeSkill(root: string, name: string): void {
  const skillDir = join(root, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `# ${name}\n`, 'utf-8');
}

describe('Skill selection', () => {
  const originalEnv = process.env.CLAUDE_MEM_INSTALL_ALL_SKILLS;

  beforeEach(() => {
    delete process.env.CLAUDE_MEM_INSTALL_ALL_SKILLS;
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    process.env.CLAUDE_MEM_INSTALL_ALL_SKILLS = originalEnv;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('defaults to the compact cross-runtime skill set', () => {
    expect(DEFAULT_CLAUDE_MEM_SKILLS).toEqual([
      'mem-search',
      'smart-explore',
      'learn-codebase',
      'how-it-works',
      'timeline-report',
      'weekly-digests',
      'standup',
      'pathfinder',
    ]);
  });

  it('removes extra skills from an installed skills directory by default', () => {
    const skillsDir = join(tempDir, 'skills');
    writeSkill(skillsDir, 'mem-search');
    writeSkill(skillsDir, 'pathfinder');
    writeSkill(skillsDir, 'wowerpoint');
    writeSkill(skillsDir, 'version-bump');

    const result = filterClaudeMemSkillsDirectory(skillsDir);

    expect(result.filtered).toBe(true);
    expect(result.kept).toContain('mem-search');
    expect(result.kept).toContain('pathfinder');
    expect(result.removed).toEqual(['version-bump', 'wowerpoint']);
    expect(existsSync(join(skillsDir, 'mem-search', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillsDir, 'pathfinder', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillsDir, 'wowerpoint'))).toBe(false);
    expect(existsSync(join(skillsDir, 'version-bump'))).toBe(false);
  });

  it('keeps all skills when CLAUDE_MEM_INSTALL_ALL_SKILLS=true', () => {
    process.env.CLAUDE_MEM_INSTALL_ALL_SKILLS = 'true';
    const skillsDir = join(tempDir, 'skills');
    writeSkill(skillsDir, 'mem-search');
    writeSkill(skillsDir, 'wowerpoint');

    const result = filterClaudeMemSkillsDirectory(skillsDir);

    expect(shouldInstallAllClaudeMemSkills()).toBe(true);
    expect(result.filtered).toBe(false);
    expect(result.removed).toEqual([]);
    expect(existsSync(join(skillsDir, 'wowerpoint', 'SKILL.md'))).toBe(true);
  });
});
