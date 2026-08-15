import { describe, it, expect } from 'bun:test';

import { normalizeAgentType } from '../../src/shared/agent-type.js';

describe('normalizeAgentType', () => {
  // The case that actually cost something: `Explore` and `explore` were two values across
  // 530 rows, so any filter by agent type saw half its data.
  it('folds case so one role is one value', () => {
    expect(normalizeAgentType('Explore')).toBe('explore');
    expect(normalizeAgentType('explore')).toBe('explore');
  });

  it('folds whitespace and underscores to hyphens', () => {
    expect(normalizeAgentType('general purpose')).toBe('general-purpose');
    expect(normalizeAgentType('general_purpose')).toBe('general-purpose');
    expect(normalizeAgentType('general--purpose')).toBe('general-purpose');
  });

  it('trims surrounding whitespace and separators', () => {
    expect(normalizeAgentType('  -Explore-  ')).toBe('explore');
  });

  // Undefined rather than an empty string: the column is nullable and an empty tag would be a
  // 468th distinct value that means "none".
  it('returns undefined for absent or empty values', () => {
    expect(normalizeAgentType(undefined)).toBeUndefined();
    expect(normalizeAgentType(null)).toBeUndefined();
    expect(normalizeAgentType('   ')).toBeUndefined();
    expect(normalizeAgentType('---')).toBeUndefined();
    expect(normalizeAgentType(42 as unknown as string)).toBeUndefined();
  });

  it('leaves an already-canonical instance name untouched', () => {
    expect(normalizeAgentType('impl-mk-cluster-os')).toBe('impl-mk-cluster-os');
  });
});
