import { describe, it, expect, mock } from 'bun:test';
import { SearchManager } from '../../src/services/worker/SearchManager.js';

describe('SearchManager cross-harness hydration (platform_source ignored on reads)', () => {
  it('ignores platformSource in Chroma observation where filter and SQLite hydration', async () => {
    const observation = {
      id: 5,
      memory_session_id: 'cursor-memory-id',
      project: 'search-project',
      text: null,
      type: 'discovery',
      title: 'cursor overlap observation',
      subtitle: null,
      facts: '[]',
      narrative: 'cursor overlap narrative',
      concepts: '[]',
      files_read: '[]',
      files_modified: '[]',
      prompt_number: 1,
      discovery_tokens: 0,
      created_at: new Date().toISOString(),
      created_at_epoch: Date.now(),
    };
    const getObservationsByIds = mock(() => [observation]);
    const queryChroma = mock(() => Promise.resolve({
      ids: [observation.id],
      distances: [0.1],
      metadatas: [{
        sqlite_id: observation.id,
        doc_type: 'observation',
        project: 'search-project',
        platform_source: 'cursor',
        created_at_epoch: Date.now(),
      }],
    }));

    const manager = new SearchManager(
      {
        searchObservations: mock(() => []),
        searchSessions: mock(() => []),
        searchUserPrompts: mock(() => []),
      } as any,
      {
        getObservationsByIds,
        getSessionSummariesByIds: mock(() => []),
        getUserPromptsByIds: mock(() => []),
      } as any,
      { queryChroma } as any,
      {} as any,
      {} as any,
    );

    const result = await manager.search({
      query: 'overlap',
      type: 'observations',
      project: 'search-project',
      platformSource: 'cursor',
      format: 'json',
      limit: 10,
    });

    expect(queryChroma).toHaveBeenCalledWith('overlap', 100, {
      $and: [
        { doc_type: 'observation' },
        { $or: [{ project: 'search-project' }, { merged_into_project: 'search-project' }] },
      ],
    });
    const obsHydrationArg = getObservationsByIds.mock.calls[0][1];
    expect(obsHydrationArg).toEqual(expect.objectContaining({ project: 'search-project' }));
    expect(obsHydrationArg).not.toHaveProperty('platformSource');
    expect(result.observations).toEqual([observation]);
  });

  it('ignores platformSource in Chroma session where filter and SQLite hydration', async () => {
    const session = {
      id: 6,
      memory_session_id: 'cursor-memory-id',
      project: 'search-project',
      request: 'cursor overlap session',
      investigated: null,
      learned: null,
      completed: null,
      next_steps: null,
      files_read: null,
      files_edited: null,
      notes: null,
      prompt_number: 1,
      discovery_tokens: 0,
      created_at: new Date().toISOString(),
      created_at_epoch: Date.now(),
    };
    const getSessionSummariesByIds = mock(() => [session]);
    const queryChroma = mock(() => Promise.resolve({
      ids: [session.id],
      distances: [0.1],
      metadatas: [{
        sqlite_id: session.id,
        doc_type: 'session_summary',
        project: 'search-project',
        platform_source: 'cursor',
        created_at_epoch: Date.now(),
      }],
    }));

    const manager = new SearchManager(
      {
        searchObservations: mock(() => []),
        searchSessions: mock(() => []),
        searchUserPrompts: mock(() => []),
      } as any,
      {
        getObservationsByIds: mock(() => []),
        getSessionSummariesByIds,
        getUserPromptsByIds: mock(() => []),
      } as any,
      { queryChroma } as any,
      {} as any,
      {} as any,
    );

    const result = await manager.search({
      query: 'overlap',
      type: 'sessions',
      project: 'search-project',
      platformSource: 'cursor',
      format: 'json',
      limit: 10,
    });

    expect(queryChroma).toHaveBeenCalledWith('overlap', 100, {
      $and: [
        { doc_type: 'session_summary' },
        { $or: [{ project: 'search-project' }, { merged_into_project: 'search-project' }] },
      ],
    });
    expect(getSessionSummariesByIds).toHaveBeenCalledWith([session.id], {
      orderBy: 'date_desc',
      limit: 10,
      project: 'search-project',
      platformSource: undefined,
    });
    expect(result.sessions).toEqual([session]);
  });

  it('ignores platformSource in Chroma prompt SQLite hydration', async () => {
    const prompt = {
      id: 7,
      content_session_id: 'shared-raw-id',
      prompt_number: 1,
      prompt_text: 'cursor overlap prompt',
      project: 'search-project',
      platform_source: 'cursor',
      created_at: new Date().toISOString(),
      created_at_epoch: Date.now(),
    };
    const getUserPromptsByIds = mock(() => [prompt]);
    const queryChroma = mock(() => Promise.resolve({
      ids: [prompt.id],
      distances: [0.1],
      metadatas: [{
        sqlite_id: prompt.id,
        doc_type: 'user_prompt',
        project: 'search-project',
        platform_source: 'cursor',
        created_at_epoch: Date.now(),
      }],
    }));

    const manager = new SearchManager(
      {
        searchObservations: mock(() => []),
        searchSessions: mock(() => []),
        searchUserPrompts: mock(() => []),
      } as any,
      {
        getObservationsByIds: mock(() => []),
        getSessionSummariesByIds: mock(() => []),
        getUserPromptsByIds,
      } as any,
      { queryChroma } as any,
      {} as any,
      {} as any,
    );

    const result = await manager.search({
      query: 'overlap',
      type: 'prompts',
      project: 'search-project',
      platformSource: 'cursor',
      format: 'json',
      limit: 10,
    });

    expect(getUserPromptsByIds).toHaveBeenCalledWith([prompt.id], {
      orderBy: 'date_desc',
      limit: 10,
      project: 'search-project',
      platformSource: undefined,
    });
    expect(result.prompts).toEqual([prompt]);
  });

  it('ignores platformSource in getTimelineByQuery auto-mode hydration', async () => {
    const observation = {
      id: 8,
      memory_session_id: 'cursor-memory-id',
      project: 'search-project',
      text: null,
      type: 'discovery',
      title: 'cursor timeline anchor',
      subtitle: null,
      facts: '[]',
      narrative: 'cursor timeline narrative',
      concepts: '[]',
      files_read: '[]',
      files_modified: '[]',
      prompt_number: 1,
      discovery_tokens: 0,
      created_at: new Date().toISOString(),
      created_at_epoch: Date.now(),
    };
    const searchObservations = mock(() => [observation]);
    const getTimelineAroundObservation = mock(() => ({
      observations: [],
      sessions: [],
      prompts: [],
    }));

    const manager = new SearchManager(
      {
        searchObservations,
        searchSessions: mock(() => []),
        searchUserPrompts: mock(() => []),
      } as any,
      {
        getObservationsByIds: mock(() => []),
        getSessionSummariesByIds: mock(() => []),
        getUserPromptsByIds: mock(() => []),
        getTimelineAroundObservation,
      } as any,
      null,
      {} as any,
      { filterByDepth: mock(() => []) } as any,
    );

    await manager.getTimelineByQuery({
      query: 'timeline',
      mode: 'auto',
      project: 'search-project',
      platform_source: 'cursor',
    });

    expect(searchObservations).toHaveBeenCalledWith('timeline', {
      project: 'search-project',
      platformSource: undefined,
      limit: 1,
    });
    expect(getTimelineAroundObservation).toHaveBeenCalledWith(
      observation.id,
      observation.created_at_epoch,
      10,
      10,
      'search-project',
      undefined,
    );
  });

  // NOTE: the old "platform-scoped Chroma zero → FTS fallback" case is gone.
  // Reads are cross-harness now (normalizeParams strips platformSource), so a
  // scoped-zero result can no longer occur through the public search() API; an
  // empty Chroma result is always treated as final — covered below.
  it('keeps Chroma zero matches final without SQLite/FTS fallback', async () => {
    const searchObservations = mock(() => []);
    const searchSessions = mock(() => []);
    const searchUserPrompts = mock(() => []);
    const queryChroma = mock(() => Promise.resolve({
      ids: [],
      distances: [],
      metadatas: [],
    }));

    const manager = new SearchManager(
      {
        searchObservations,
        searchSessions,
        searchUserPrompts,
      } as any,
      {
        getObservationsByIds: mock(() => []),
        getSessionSummariesByIds: mock(() => []),
        getUserPromptsByIds: mock(() => []),
      } as any,
      { queryChroma } as any,
      {} as any,
      {} as any,
    );
    const telemetry = {};

    const result = await manager.search({
      query: 'legacy metadata',
      format: 'json',
    }, telemetry);

    expect(searchObservations).not.toHaveBeenCalled();
    expect(searchSessions).not.toHaveBeenCalled();
    expect(searchUserPrompts).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      observations: [],
      sessions: [],
      prompts: [],
      totalResults: 0,
    }));
    expect(telemetry).toEqual(expect.objectContaining({
      result_count: 0,
      search_strategy: 'chroma',
      chroma_available: true,
      fallback_reason: 'none',
    }));
  });
});
