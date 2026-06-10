import { describe, expect, it } from 'bun:test';
import {
  buildServerBetaObservationAddRequest,
  normalizeServerBetaProjectId,
} from '../../src/servers/mcp-server-beta-normalize.js';

describe('server-beta MCP fork fixes', () => {
  const settingsProjectId = '38f60e2a-63ed-4180-ba81-faa1d3698a26';

  it('passes UUID projectId values through unchanged', () => {
    expect(normalizeServerBetaProjectId('11111111-2222-4333-8444-555555555555', settingsProjectId))
      .toBe('11111111-2222-4333-8444-555555555555');
  });

  it('maps project aliases to the configured server-beta project id', () => {
    expect(normalizeServerBetaProjectId('MKS', settingsProjectId)).toBe(settingsProjectId);
    expect(normalizeServerBetaProjectId(undefined, settingsProjectId)).toBe(settingsProjectId);
  });

  it('builds add payloads with content and legacy narrative alias', () => {
    expect(buildServerBetaObservationAddRequest({
      projectId: 'MKS',
      settingsProjectId,
      content: 'CMEM fork write marker',
      kind: 'manual',
      metadata: { source: 'test' },
    })).toEqual({
      projectId: settingsProjectId,
      content: 'CMEM fork write marker',
      narrative: 'CMEM fork write marker',
      kind: 'manual',
      metadata: { source: 'test' },
    });
  });
});
