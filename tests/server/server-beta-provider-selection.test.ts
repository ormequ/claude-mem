import { describe, expect, it } from 'bun:test';
import { resolveServerGenerationProviderName } from '../../src/server/runtime/create-server-beta-service.js';

describe('server-beta generation provider selection', () => {
  it('falls back to CLAUDE_MEM_PROVIDER for local fork installs', () => {
    expect(resolveServerGenerationProviderName({
      CLAUDE_MEM_PROVIDER: 'openrouter',
    })).toBe('openrouter');
  });

  it('lets CLAUDE_MEM_SERVER_PROVIDER override the worker-era provider', () => {
    expect(resolveServerGenerationProviderName({
      CLAUDE_MEM_PROVIDER: 'openrouter',
      CLAUDE_MEM_SERVER_PROVIDER: 'gemini',
    })).toBe('gemini');
  });
});
