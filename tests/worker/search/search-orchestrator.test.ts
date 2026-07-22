import { describe, it, expect, mock } from 'bun:test';
import { SearchOrchestrator } from '../../../src/services/worker/search/SearchOrchestrator.js';

const observation = {
  id: 21,
  memory_session_id: 'cursor-memory',
  project: 'orchestrator-project',
  text: null,
  type: 'discovery',
  title: 'cursor sqlite fallback',
  subtitle: null,
  facts: '[]',
  narrative: 'fallback through sqlite strategy',
  concepts: '[]',
  files_read: '[]',
  files_modified: '[]',
  prompt_number: 1,
  discovery_tokens: 0,
  created_at: '2025-01-01T00:00:00.000Z',
  created_at_epoch: 1735689600000,
};

describe('SearchOrchestrator cross-harness search (platform_source ignored on reads)', () => {
  // NOTE: the old "platform-scoped Chroma zero → SQLite fallback" case is gone.
  // normalizeParams strips platformSource, so no scoped-zero can occur through
  // the public search() API; an empty Chroma result is always final (below),
  // and the where-filter never carries a platform_source clause.
  it('ignores a requested platform_source in the Chroma where filter', async () => {
    const queryChroma = mock(() => Promise.resolve({ ids: [], distances: [], metadatas: [] }));
    const searchObservations = mock(() => [observation]);
    const orchestrator = new SearchOrchestrator(
      {
        searchObservations,
        searchSessions: mock(() => []),
        searchUserPrompts: mock(() => []),
      } as any,
      {
        getObservationsByIds: mock(() => []),
        getSessionSummariesByIds: mock(() => []),
        getUserPromptsByIds: mock(() => []),
      } as any,
      { queryChroma } as any,
    );

    const result = await orchestrator.search({
      query: 'legacy docs',
      searchType: 'observations',
      project: 'orchestrator-project',
      platform_source: 'Cursor',
      limit: 5,
    });

    // No { platform_source: ... } clause; empty Chroma is final (no FTS fallback).
    expect(queryChroma).toHaveBeenCalledWith(
      'legacy docs',
      100,
      { $and: [{ doc_type: 'observation' }, { $or: [{ project: 'orchestrator-project' }, { merged_into_project: 'orchestrator-project' }] }] },
    );
    expect(searchObservations).not.toHaveBeenCalled();
    expect(result.usedChroma).toBe(true);
    expect(result.strategy).toBe('chroma');
    expect(result.results.observations).toHaveLength(0);
  });

  it('keeps unscoped Chroma zero matches final', async () => {
    const queryChroma = mock(() => Promise.resolve({ ids: [], distances: [], metadatas: [] }));
    const searchObservations = mock(() => [observation]);
    const orchestrator = new SearchOrchestrator(
      {
        searchObservations,
        searchSessions: mock(() => []),
        searchUserPrompts: mock(() => []),
      } as any,
      {
        getObservationsByIds: mock(() => []),
        getSessionSummariesByIds: mock(() => []),
        getUserPromptsByIds: mock(() => []),
      } as any,
      { queryChroma } as any,
    );

    const result = await orchestrator.search({
      query: 'legacy docs',
      searchType: 'observations',
      project: 'orchestrator-project',
      limit: 5,
    });

    expect(searchObservations).not.toHaveBeenCalled();
    expect(result.usedChroma).toBe(true);
    expect(result.strategy).toBe('chroma');
    expect(result.results.observations).toHaveLength(0);
  });
});
