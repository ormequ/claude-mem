import { describe, expect, it } from 'bun:test';
import {
  resolveServerGenerationModelName,
  resolveServerGenerationProviderName,
} from '../../src/server/runtime/create-server-beta-service.js';

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

  it('falls back to CLAUDE_MEM_OPENROUTER_MODEL for server-beta OpenRouter generation', () => {
    expect(resolveServerGenerationModelName('openrouter', {
      CLAUDE_MEM_OPENROUTER_MODEL: 'qwen3.6-27b',
    })).toBe('qwen3.6-27b');
  });

  it('lets CLAUDE_MEM_SERVER_MODEL override provider-specific model settings', () => {
    expect(resolveServerGenerationModelName('openrouter', {
      CLAUDE_MEM_SERVER_MODEL: 'server-model',
      CLAUDE_MEM_OPENROUTER_MODEL: 'openrouter-model',
    })).toBe('server-model');
  });
});
