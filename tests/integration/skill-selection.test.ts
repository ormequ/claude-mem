import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  COMPACT_CLAUDE_MEM_SKILLS,
  DEFAULT_CLAUDE_MEM_SKILLS,
  claudeMemSkillAllowlist,
  filterClaudeMemSkillsDirectory,
  resolveClaudeMemSkillSet,
  shouldInstallAllClaudeMemSkills,
} from '../../src/services/integrations/SkillSelection';

const tempDir = join(tmpdir(), `claude-mem-skill-selection-${process.pid}`);

function writeSkill(root: string, name: string): void {
  const skillDir = join(root, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `# ${name}\n`, 'utf-8');
}

describe('Skill selection', () => {
  const originalAllEnv = process.env.CLAUDE_MEM_INSTALL_ALL_SKILLS;
  const originalSetEnv = process.env.CLAUDE_MEM_SKILL_SET;
  const originalSmartToolsEnv = process.env.CLAUDE_MEM_SMART_TOOLS;

  beforeEach(() => {
    delete process.env.CLAUDE_MEM_INSTALL_ALL_SKILLS;
    delete process.env.CLAUDE_MEM_SKILL_SET;
    // The default allowlist is smart-tools-dependent, so a real
    // CLAUDE_MEM_SMART_TOOLS=false in the dev environment would otherwise
    // leak into every default-set assertion below.
    delete process.env.CLAUDE_MEM_SMART_TOOLS;
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    process.env.CLAUDE_MEM_INSTALL_ALL_SKILLS = originalAllEnv;
    process.env.CLAUDE_MEM_SKILL_SET = originalSetEnv;
    process.env.CLAUDE_MEM_SMART_TOOLS = originalSmartToolsEnv;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('default set is the core + reports, including knowledge-agent', () => {
    expect(DEFAULT_CLAUDE_MEM_SKILLS).toEqual([
      'mem-search',
      'smart-explore',
      'learn-codebase',
      'how-it-works',
      'timeline-report',
      'weekly-digests',
      'standup',
      'pathfinder',
      'knowledge-agent',
    ]);
  });

  it('drops smart-explore from the default set when smart tools are disabled', () => {
    process.env.CLAUDE_MEM_SMART_TOOLS = 'false';
    delete process.env.CLAUDE_MEM_SKILL_SET;
    const allowlist = claudeMemSkillAllowlist();
    expect(allowlist).not.toBeNull();
    expect(allowlist).not.toContain('smart-explore');
    expect(allowlist).toContain('mem-search');
    delete process.env.CLAUDE_MEM_SMART_TOOLS;
  });

  it('keeps smart-explore in the default set when smart tools are enabled', () => {
    expect(claudeMemSkillAllowlist()).toContain('smart-explore');
  });

  it('compact set is knowledge-agent + mem-search + learn-codebase', () => {
    expect(COMPACT_CLAUDE_MEM_SKILLS).toEqual([
      'knowledge-agent',
      'mem-search',
      'learn-codebase',
    ]);
  });

  it('resolves the skill set from CLAUDE_MEM_SKILL_SET', () => {
    expect(resolveClaudeMemSkillSet()).toBe('default');

    process.env.CLAUDE_MEM_SKILL_SET = 'compact';
    expect(resolveClaudeMemSkillSet()).toBe('compact');

    process.env.CLAUDE_MEM_SKILL_SET = 'FULL';
    expect(resolveClaudeMemSkillSet()).toBe('full');

    process.env.CLAUDE_MEM_SKILL_SET = 'nonsense';
    expect(resolveClaudeMemSkillSet()).toBe('default');
  });

  it('legacy CLAUDE_MEM_INSTALL_ALL_SKILLS=true maps to full', () => {
    process.env.CLAUDE_MEM_INSTALL_ALL_SKILLS = 'true';
    expect(resolveClaudeMemSkillSet()).toBe('full');
    expect(shouldInstallAllClaudeMemSkills()).toBe(true);
    expect(claudeMemSkillAllowlist()).toBeNull();
  });

  it('CLAUDE_MEM_SKILL_SET wins over the legacy flag', () => {
    process.env.CLAUDE_MEM_INSTALL_ALL_SKILLS = 'true';
    process.env.CLAUDE_MEM_SKILL_SET = 'compact';
    expect(resolveClaudeMemSkillSet()).toBe('compact');
  });

  it('keeps the default set and removes extras by default', () => {
    const skillsDir = join(tempDir, 'skills');
    writeSkill(skillsDir, 'mem-search');
    writeSkill(skillsDir, 'pathfinder');
    writeSkill(skillsDir, 'knowledge-agent');
    writeSkill(skillsDir, 'wowerpoint');
    writeSkill(skillsDir, 'version-bump');

    const result = filterClaudeMemSkillsDirectory(skillsDir);

    expect(result.filtered).toBe(true);
    expect(result.set).toBe('default');
    expect(result.kept).toContain('mem-search');
    expect(result.kept).toContain('pathfinder');
    expect(result.kept).toContain('knowledge-agent');
    expect(result.removed).toEqual(['version-bump', 'wowerpoint']);
    expect(existsSync(join(skillsDir, 'knowledge-agent', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillsDir, 'wowerpoint'))).toBe(false);
    expect(existsSync(join(skillsDir, 'version-bump'))).toBe(false);
  });

  it('compact set keeps only knowledge-agent, mem-search, learn-codebase', () => {
    process.env.CLAUDE_MEM_SKILL_SET = 'compact';
    const skillsDir = join(tempDir, 'skills');
    writeSkill(skillsDir, 'knowledge-agent');
    writeSkill(skillsDir, 'mem-search');
    writeSkill(skillsDir, 'learn-codebase');
    writeSkill(skillsDir, 'pathfinder');
    writeSkill(skillsDir, 'standup');

    const result = filterClaudeMemSkillsDirectory(skillsDir);

    expect(result.filtered).toBe(true);
    expect(result.set).toBe('compact');
    expect(result.kept.sort()).toEqual(['knowledge-agent', 'learn-codebase', 'mem-search']);
    expect(result.removed).toEqual(['pathfinder', 'standup']);
    expect(existsSync(join(skillsDir, 'pathfinder'))).toBe(false);
    expect(existsSync(join(skillsDir, 'knowledge-agent', 'SKILL.md'))).toBe(true);
  });

  it('full set keeps everything', () => {
    process.env.CLAUDE_MEM_SKILL_SET = 'full';
    const skillsDir = join(tempDir, 'skills');
    writeSkill(skillsDir, 'mem-search');
    writeSkill(skillsDir, 'wowerpoint');

    const result = filterClaudeMemSkillsDirectory(skillsDir);

    expect(result.filtered).toBe(false);
    expect(result.set).toBe('full');
    expect(result.removed).toEqual([]);
    expect(existsSync(join(skillsDir, 'wowerpoint', 'SKILL.md'))).toBe(true);
  });
});
