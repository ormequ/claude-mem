import { describe, it, expect } from 'bun:test';
import { resolveTierAlias, resolveOpenRouterQaModel } from '../../src/services/worker/model-aliases.js';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../src/shared/SettingsDefaultsManager.js';

/**
 * #2289 — $TIER alias syntax in CLAUDE_MEM_MODEL resolves at request time to a
 * provider-appropriate concrete model, reusing the portable-alias machinery.
 */
function settingsWith(overrides: Partial<SettingsDefaults> = {}): SettingsDefaults {
  return { ...SettingsDefaultsManager.getAllDefaults(), ...overrides };
}

describe('resolveTierAlias (#2289)', () => {
  it('resolves $TIER:fast to CLAUDE_MEM_TIER_FAST_MODEL', () => {
    const settings = settingsWith({ CLAUDE_MEM_TIER_FAST_MODEL: 'claude-haiku-4-5-20251001' });
    expect(resolveTierAlias('$TIER:fast', settings)).toBe('claude-haiku-4-5-20251001');
  });

  it('resolves $TIER:smart to CLAUDE_MEM_TIER_SMART_MODEL', () => {
    const settings = settingsWith({ CLAUDE_MEM_TIER_SMART_MODEL: 'claude-sonnet-4-5-20250101' });
    expect(resolveTierAlias('$TIER:smart', settings)).toBe('claude-sonnet-4-5-20250101');
  });

  it('resolves $TIER:simple to CLAUDE_MEM_TIER_SIMPLE_MODEL', () => {
    const settings = settingsWith({ CLAUDE_MEM_TIER_SIMPLE_MODEL: 'haiku' });
    expect(resolveTierAlias('$TIER:simple', settings)).toBe('haiku');
  });

  it('resolves $TIER:summary to CLAUDE_MEM_MODEL when no summary model is set', () => {
    const settings = settingsWith({ CLAUDE_MEM_MODEL: 'claude-opus', CLAUDE_MEM_TIER_SUMMARY_MODEL: '' });
    expect(resolveTierAlias('$TIER:summary', settings)).toBe('claude-opus');
  });

  it('passes through a concrete model unchanged', () => {
    const settings = settingsWith();
    expect(resolveTierAlias('claude-haiku-4-5-20251001', settings)).toBe('claude-haiku-4-5-20251001');
  });

  it('passes through an unknown $TIER:* token unchanged (anchored, non-greedy)', () => {
    const settings = settingsWith();
    expect(resolveTierAlias('$TIER:bogus', settings)).toBe('$TIER:bogus');
    expect(resolveTierAlias('prefix-$TIER:fast', settings)).toBe('prefix-$TIER:fast');
  });

  it('does not mutate the settings object', () => {
    const settings = settingsWith({ CLAUDE_MEM_TIER_FAST_MODEL: 'haiku' });
    const snapshot = JSON.stringify(settings);
    resolveTierAlias('$TIER:fast', settings);
    expect(JSON.stringify(settings)).toBe(snapshot);
  });

  it('falls back to portable defaults when the tier model is empty', () => {
    const settings = settingsWith({ CLAUDE_MEM_TIER_FAST_MODEL: '', CLAUDE_MEM_TIER_SMART_MODEL: '' });
    expect(resolveTierAlias('$TIER:fast', settings)).toBe('haiku');
    expect(resolveTierAlias('$TIER:smart', settings)).toBe('sonnet');
  });
});

// Knowledge-agent Q&A should be able to use a stronger model than bulk
// generation/summary on the OpenRouter path, while staying backwards compatible.
describe('resolveOpenRouterQaModel', () => {
  it('falls back to the bulk OpenRouter model when QA model is unset', () => {
    const settings = settingsWith({
      CLAUDE_MEM_OPENROUTER_QA_MODEL: '',
      CLAUDE_MEM_OPENROUTER_MODEL: 'xiaomi/mimo-v2-flash:free',
    });
    expect(resolveOpenRouterQaModel(settings)).toBe('xiaomi/mimo-v2-flash:free');
  });

  it('treats a whitespace-only QA model as unset', () => {
    const settings = settingsWith({
      CLAUDE_MEM_OPENROUTER_QA_MODEL: '   ',
      CLAUDE_MEM_OPENROUTER_MODEL: 'deepseek/deepseek-chat',
    });
    expect(resolveOpenRouterQaModel(settings)).toBe('deepseek/deepseek-chat');
  });

  it('uses a concrete QA model when set', () => {
    const settings = settingsWith({
      CLAUDE_MEM_OPENROUTER_QA_MODEL: 'anthropic/claude-sonnet-4',
      CLAUDE_MEM_OPENROUTER_MODEL: 'xiaomi/mimo-v2-flash:free',
    });
    expect(resolveOpenRouterQaModel(settings)).toBe('anthropic/claude-sonnet-4');
  });

  it('resolves a $TIER:smart QA model via the tier table', () => {
    const settings = settingsWith({
      CLAUDE_MEM_OPENROUTER_QA_MODEL: '$TIER:smart',
      CLAUDE_MEM_TIER_SMART_MODEL: 'anthropic/claude-sonnet-4',
      CLAUDE_MEM_OPENROUTER_MODEL: 'xiaomi/mimo-v2-flash:free',
    });
    expect(resolveOpenRouterQaModel(settings)).toBe('anthropic/claude-sonnet-4');
  });
});
