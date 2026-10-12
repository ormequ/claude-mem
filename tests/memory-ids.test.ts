import { describe, test, expect } from 'bun:test';
import { normalizeMemoryIds } from '../src/utils/memory-ids.js';

describe('normalizeMemoryIds', () => {
  test('passes bare observation ids through', () => {
    expect(normalizeMemoryIds([55238, '55241'], 'observation')).toEqual([55238, 55241]);
  });

  test('rejects a session id instead of resolving it to an observation', () => {
    expect(() => normalizeMemoryIds([5254], 'observation')).not.toThrow(); // bare number is indistinguishable
    expect(() => normalizeMemoryIds(['S5254'], 'observation')).toThrow(/session id/);
    expect(() => normalizeMemoryIds(['#S5254'], 'observation')).toThrow(/session id/);
    expect(() => normalizeMemoryIds(['S5254'], 'prompt')).toThrow(/session id/);
  });

  test('accepts the P prefix for prompts and rejects it for observations', () => {
    expect(normalizeMemoryIds(['P1234', 1234], 'prompt')).toEqual([1234, 1234]);
    expect(() => normalizeMemoryIds(['P1234'], 'observation')).toThrow(/prompt id/);
  });

  test('rejects malformed ids', () => {
    expect(() => normalizeMemoryIds(['abc'], 'observation')).toThrow(/Invalid/);
    expect(() => normalizeMemoryIds([0], 'observation')).toThrow(/Invalid/);
  });
});
