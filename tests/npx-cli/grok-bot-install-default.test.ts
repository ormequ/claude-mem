import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resolveInstallerProviderChoice } from '../../src/npx-cli/installer-provider-choice';

const repoRoot = join(__dirname, '..', '..');

describe('grok-bot install default provider', () => {
  // Fork: no CMEM Pro default (it needs a cmem.ai account); grok-bot gets the
  // installer's normal default like every other IDE.
  it('gives --ide grok-bot with no --provider no implicit provider', () => {
    expect(resolveInstallerProviderChoice({ ide: 'grok-bot' })).toBeUndefined();
  });

  it('keeps --provider host as an explicit grok-bot opt-in', () => {
    expect(resolveInstallerProviderChoice({ ide: 'grok-bot', provider: 'host' })).toBe('host');
  });

  it('does not invent a non-interactive default for other IDEs', () => {
    expect(resolveInstallerProviderChoice({ ide: 'cursor' })).toBeUndefined();
    expect(resolveInstallerProviderChoice({ ide: 'claude-code' })).toBeUndefined();
    expect(resolveInstallerProviderChoice({})).toBeUndefined();
  });

  it('documents CMEM Pro as the grok-bot plugin default and host as opt-in', () => {
    const skill = readFileSync(join(repoRoot, 'claude-mem-grok-bot/skills/install/SKILL.md'), 'utf-8');
    const readme = readFileSync(join(repoRoot, 'claude-mem-grok-bot/README.md'), 'utf-8');
    const defaultSection = skill.split('## Optional')[0];

    expect(defaultSection).toContain('npx claude-mem install --ide grok-bot');
    expect(defaultSection).not.toContain('npx claude-mem install --ide grok-bot --provider host');
    expect(defaultSection).toContain('https://cmem.ai/api/inference/v1');
    expect(defaultSection).toContain('cmem-observer');
    expect(defaultSection.toLowerCase()).not.toContain('host-login observer (default)');
    expect(skill).toContain('npx claude-mem install --ide grok-bot --provider host');
    expect(readme).toContain('npx claude-mem install --ide grok-bot');
    expect(readme).not.toContain('npx claude-mem install --ide grok-bot --provider host');
  });
});
