import { describe, it, expect } from 'bun:test';
import { smartToolsEnabled, SMART_TOOL_NAMES } from '../../src/shared/smart-tools.js';

describe('smartToolsEnabled', () => {
  it('defaults to enabled', () => {
    expect(smartToolsEnabled({})).toBe(true);
  });
  it('disables on "false" and "0" (case/space-insensitive)', () => {
    expect(smartToolsEnabled({ CLAUDE_MEM_SMART_TOOLS: 'false' })).toBe(false);
    expect(smartToolsEnabled({ CLAUDE_MEM_SMART_TOOLS: ' FALSE ' })).toBe(false);
    expect(smartToolsEnabled({ CLAUDE_MEM_SMART_TOOLS: '0' })).toBe(false);
  });
  it('stays enabled for any other value', () => {
    expect(smartToolsEnabled({ CLAUDE_MEM_SMART_TOOLS: 'true' })).toBe(true);
    expect(smartToolsEnabled({ CLAUDE_MEM_SMART_TOOLS: '' })).toBe(true);
  });
  it('names exactly the three smart tools', () => {
    expect([...SMART_TOOL_NAMES].sort()).toEqual(['smart_outline', 'smart_search', 'smart_unfold']);
  });
});
