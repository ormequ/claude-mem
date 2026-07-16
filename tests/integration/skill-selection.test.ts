import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  COMPACT_CLAUDE_MEM_SKILLS,
  DEFAULT_CLAUDE_MEM_SKILLS,
  claudeMemSkillAllowlist,
  filterClaudeMemSkillsDirectory,
  filterClaudeMemSkillsInPluginRoot,
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
  const originalExtraSkillsEnv = process.env.CLAUDE_MEM_INSTALL_EXTRA_SKILLS;

  beforeEach(() => {
    delete process.env.CLAUDE_MEM_INSTALL_ALL_SKILLS;
    delete process.env.CLAUDE_MEM_SKILL_SET;
    // The default allowlist is smart-tools-dependent, so a real
    // CLAUDE_MEM_SMART_TOOLS=false in the dev environment would otherwise
    // leak into every default-set assertion below.
    delete process.env.CLAUDE_MEM_SMART_TOOLS;
    delete process.env.CLAUDE_MEM_INSTALL_EXTRA_SKILLS;
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    process.env.CLAUDE_MEM_INSTALL_ALL_SKILLS = originalAllEnv;
    process.env.CLAUDE_MEM_SKILL_SET = originalSetEnv;
    process.env.CLAUDE_MEM_SMART_TOOLS = originalSmartToolsEnv;
    if (originalExtraSkillsEnv === undefined) {
      delete process.env.CLAUDE_MEM_INSTALL_EXTRA_SKILLS;
    } else {
      process.env.CLAUDE_MEM_INSTALL_EXTRA_SKILLS = originalExtraSkillsEnv;
    }
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

  it('compact set is knowledge-agent + mem-search + pathfinder + timeline-report', () => {
    expect(COMPACT_CLAUDE_MEM_SKILLS).toEqual([
      'knowledge-agent',
      'mem-search',
      'pathfinder',
      'timeline-report',
    ]);
  });

  it('compact keeps timeline-report but not its weekly-digests duplicate', () => {
    expect(COMPACT_CLAUDE_MEM_SKILLS).toContain('timeline-report');
    expect(COMPACT_CLAUDE_MEM_SKILLS).not.toContain('weekly-digests');
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

  it('compact set keeps only knowledge-agent, mem-search, pathfinder, timeline-report', () => {
    process.env.CLAUDE_MEM_SKILL_SET = 'compact';
    const skillsDir = join(tempDir, 'skills');
    writeSkill(skillsDir, 'knowledge-agent');
    writeSkill(skillsDir, 'mem-search');
    writeSkill(skillsDir, 'pathfinder');
    writeSkill(skillsDir, 'timeline-report');
    writeSkill(skillsDir, 'learn-codebase');
    writeSkill(skillsDir, 'weekly-digests');
    writeSkill(skillsDir, 'standup');

    const result = filterClaudeMemSkillsDirectory(skillsDir);

    expect(result.filtered).toBe(true);
    expect(result.set).toBe('compact');
    expect(result.kept.sort()).toEqual([
      'knowledge-agent',
      'mem-search',
      'pathfinder',
      'timeline-report',
    ]);
    expect(result.removed).toEqual(['learn-codebase', 'standup', 'weekly-digests']);
    expect(existsSync(join(skillsDir, 'learn-codebase'))).toBe(false);
    expect(existsSync(join(skillsDir, 'weekly-digests'))).toBe(false);
    expect(existsSync(join(skillsDir, 'timeline-report', 'SKILL.md'))).toBe(true);
  });

  it('extends the compact set with trimmed, deduplicated extra skills', () => {
    process.env.CLAUDE_MEM_SKILL_SET = 'compact';
    process.env.CLAUDE_MEM_INSTALL_EXTRA_SKILLS = ' weekly-digests, babysit, babysit, ';
    const skillsDir = join(tempDir, 'skills');
    writeSkill(skillsDir, 'knowledge-agent');
    writeSkill(skillsDir, 'mem-search');
    writeSkill(skillsDir, 'pathfinder');
    writeSkill(skillsDir, 'timeline-report');
    writeSkill(skillsDir, 'learn-codebase');
    writeSkill(skillsDir, 'weekly-digests');
    writeSkill(skillsDir, 'babysit');
    writeSkill(skillsDir, 'standup');

    const result = filterClaudeMemSkillsDirectory(skillsDir);

    expect(result.filtered).toBe(true);
    expect(result.set).toBe('compact');
    expect(result.kept.sort()).toEqual([
      'babysit',
      'knowledge-agent',
      'mem-search',
      'pathfinder',
      'timeline-report',
      'weekly-digests',
    ]);
    expect(result.removed).toEqual(['learn-codebase', 'standup']);
    expect(existsSync(join(skillsDir, 'knowledge-agent', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillsDir, 'mem-search', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillsDir, 'pathfinder', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillsDir, 'timeline-report', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillsDir, 'weekly-digests', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillsDir, 'babysit', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillsDir, 'standup'))).toBe(false);
  });

  it('rejects an unknown extra skill before removing compact-set exclusions', () => {
    process.env.CLAUDE_MEM_SKILL_SET = 'compact';
    process.env.CLAUDE_MEM_INSTALL_EXTRA_SKILLS = 'babisit';
    const skillsDir = join(tempDir, 'skills');
    writeSkill(skillsDir, 'standup');

    expect(() => filterClaudeMemSkillsDirectory(skillsDir))
      .toThrow('Unknown Claude-Mem extra skill: babisit');

    expect(existsSync(join(skillsDir, 'standup', 'SKILL.md'))).toBe(true);
  });

  it('validates plural unknown extras before removing default-set exclusions', () => {
    process.env.CLAUDE_MEM_SKILL_SET = 'default';
    process.env.CLAUDE_MEM_INSTALL_EXTRA_SKILLS = 'babisit,not-real';
    const skillsDir = join(tempDir, 'skills');
    for (const skill of DEFAULT_CLAUDE_MEM_SKILLS) {
      writeSkill(skillsDir, skill);
    }
    writeSkill(skillsDir, 'wowerpoint');

    expect(() => filterClaudeMemSkillsDirectory(skillsDir)).toThrow(
      'Unknown Claude-Mem extra skills: babisit, not-real. Available bundled skills: how-it-works, knowledge-agent, learn-codebase, mem-search, pathfinder, smart-explore, standup, timeline-report, weekly-digests, wowerpoint',
    );

    expect(existsSync(join(skillsDir, 'wowerpoint', 'SKILL.md'))).toBe(true);
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

  it('validates an unknown extra before retaining full-set skills', () => {
    process.env.CLAUDE_MEM_SKILL_SET = 'full';
    process.env.CLAUDE_MEM_INSTALL_EXTRA_SKILLS = 'babisit';
    const skillsDir = join(tempDir, 'skills');
    writeSkill(skillsDir, 'wowerpoint');

    expect(() => filterClaudeMemSkillsDirectory(skillsDir))
      .toThrow('Unknown Claude-Mem extra skill: babisit');

    expect(existsSync(join(skillsDir, 'wowerpoint', 'SKILL.md'))).toBe(true);
  });

  it('removes extra skills from a copied plugin cache root by default', () => {
    const pluginRoot = join(tempDir, 'plugin-cache');
    const skillsDir = join(pluginRoot, 'skills');
    writeSkill(skillsDir, 'mem-search');
    writeSkill(skillsDir, 'standup');
    writeSkill(skillsDir, 'wowerpoint');

    const result = filterClaudeMemSkillsInPluginRoot(pluginRoot);

    expect(result.filtered).toBe(true);
    expect(result.kept).toContain('mem-search');
    expect(result.kept).toContain('standup');
    expect(result.removed).toEqual(['wowerpoint']);
    expect(existsSync(join(skillsDir, 'mem-search', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillsDir, 'standup', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillsDir, 'wowerpoint'))).toBe(false);
  });
});
