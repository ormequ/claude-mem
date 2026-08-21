import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import {
  buildTimeline,
  countObservationsByProjects,
  queryObservationsMulti,
  querySummariesMulti,
} from '../../src/services/context/ObservationCompiler.js';
import type { ContextConfig, Observation, SummaryTimelineItem } from '../../src/services/context/types.js';

function createTestObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: 1,
    memory_session_id: 'session-123',
    type: 'discovery',
    title: 'Test Observation',
    subtitle: null,
    narrative: 'A test narrative',
    facts: '["fact1"]',
    concepts: '["concept1"]',
    files_read: null,
    files_modified: null,
    discovery_tokens: 100,
    created_at: '2025-01-01T12:00:00.000Z',
    created_at_epoch: 1735732800000,
    ...overrides,
  };
}

function createTestSummaryTimelineItem(overrides: Partial<SummaryTimelineItem> = {}): SummaryTimelineItem {
  return {
    id: 1,
    memory_session_id: 'session-123',
    request: 'Test Request',
    investigated: 'Investigated things',
    learned: 'Learned things',
    completed: 'Completed things',
    next_steps: 'Next steps',
    created_at: '2025-01-01T12:00:00.000Z',
    created_at_epoch: 1735732800000,
    shouldShowLink: false,
    ...overrides,
  };
}

describe('buildTimeline', () => {
    it('should combine observations and summaries into timeline', () => {
      const observations = [
        createTestObservation({ id: 1, created_at_epoch: 1000 }),
      ];
      const summaries = [
        createTestSummaryTimelineItem({ id: 1, created_at_epoch: 2000 }),
      ];

      const timeline = buildTimeline(observations, summaries);

      expect(timeline).toHaveLength(2);
    });

    it('should sort timeline items chronologically by epoch', () => {
      const observations = [
        createTestObservation({ id: 1, created_at_epoch: 3000 }),
        createTestObservation({ id: 2, created_at_epoch: 1000 }),
      ];
      const summaries = [
        createTestSummaryTimelineItem({ id: 1, created_at_epoch: 2000 }),
      ];

      const timeline = buildTimeline(observations, summaries);

      expect(timeline).toHaveLength(3);
      expect(timeline[0].type).toBe('observation');
      expect((timeline[0].data as Observation).id).toBe(2);
      expect(timeline[1].type).toBe('summary');
      expect(timeline[2].type).toBe('observation');
      expect((timeline[2].data as Observation).id).toBe(1);
    });

    it('should handle empty observations array', () => {
      const summaries = [
        createTestSummaryTimelineItem({ id: 1, created_at_epoch: 1000 }),
      ];

      const timeline = buildTimeline([], summaries);

      expect(timeline).toHaveLength(1);
      expect(timeline[0].type).toBe('summary');
    });

    it('should handle empty summaries array', () => {
      const observations = [
        createTestObservation({ id: 1, created_at_epoch: 1000 }),
      ];

      const timeline = buildTimeline(observations, []);

      expect(timeline).toHaveLength(1);
      expect(timeline[0].type).toBe('observation');
    });

    it('should handle both empty arrays', () => {
      const timeline = buildTimeline([], []);

      expect(timeline).toHaveLength(0);
    });

    it('should correctly tag items with their type', () => {
      const observations = [createTestObservation()];
      const summaries = [createTestSummaryTimelineItem()];

      const timeline = buildTimeline(observations, summaries);

      const observationItem = timeline.find(item => item.type === 'observation');
      const summaryItem = timeline.find(item => item.type === 'summary');

      expect(observationItem).toBeDefined();
      expect(summaryItem).toBeDefined();
      expect(observationItem!.data).toHaveProperty('narrative');
      expect(summaryItem!.data).toHaveProperty('request');
    });

    it('sorts a summary by its own time, so it closes the session it describes', () => {
      const observations = [
        createTestObservation({ id: 1, created_at_epoch: 2000 }),
      ];
      const summaries = [
        // Written at the end of the session, after that session's observations.
        createTestSummaryTimelineItem({ id: 1, created_at_epoch: 3000 }),
      ];

      const timeline = buildTimeline(observations, summaries);

      expect(timeline[0].type).toBe('observation');
      expect(timeline[1].type).toBe('summary');
    });
});

describe('context compiler cross-harness reads', () => {
  const config: ContextConfig = {
    totalObservationCount: 20,
    fullObservationCount: 3,
    sessionCount: 20,
    showReadTokens: true,
    showWorkTokens: true,
    showSavingsAmount: true,
    showSavingsPercent: true,
    observationTypes: new Set(['discovery']),
    observationConcepts: new Set(['platform-scope']),
    fullObservationField: 'narrative',
    showLastSummary: true,
    showLastMessage: false,
  };

  function seed(
    store: SessionStore,
    input: {
      project: string;
      contentSessionId: string;
      memorySessionId: string;
      platformSource: string;
      title: string;
      summaryRequest: string;
      createdAtEpoch: number;
    },
  ): void {
    const sessionDbId = store.createSDKSession(
      input.contentSessionId,
      input.project,
      `${input.platformSource} prompt`,
      undefined,
      input.platformSource,
    );
    store.ensureMemorySessionIdRegistered(sessionDbId, input.memorySessionId);
    store.storeObservation(
      input.memorySessionId,
      input.project,
      {
        type: 'discovery',
        title: input.title,
        subtitle: null,
        facts: [],
        narrative: `${input.platformSource} context narrative`,
        concepts: ['platform-scope'],
        files_read: [],
        files_modified: [],
      },
      1,
      0,
      input.createdAtEpoch,
    );
    store.storeSummary(
      input.memorySessionId,
      input.project,
      {
        request: input.summaryRequest,
        investigated: 'investigated',
        learned: 'learned',
        completed: 'completed',
        next_steps: 'next',
        notes: null,
      },
      1,
      0,
      input.createdAtEpoch,
    );
  }

  it('returns observations, summaries, and counts across all harnesses (no platform scoping)', () => {
    const store = new SessionStore(':memory:');
    try {
      seed(store, {
        project: 'context-platform-project',
        contentSessionId: 'shared-context-id',
        memorySessionId: 'codex-context-memory',
        platformSource: 'codex',
        title: 'CODEX_CONTEXT_OBS',
        summaryRequest: 'CODEX_CONTEXT_SUMMARY',
        createdAtEpoch: 1_700_000_000_000,
      });
      seed(store, {
        project: 'context-platform-project',
        contentSessionId: 'shared-context-id',
        memorySessionId: 'claude-context-memory',
        platformSource: 'claude',
        title: 'CLAUDE_CONTEXT_OBS',
        summaryRequest: 'CLAUDE_CONTEXT_SUMMARY',
        createdAtEpoch: 1_700_000_001_000,
      });

      // A single session's read sees BOTH the codex- and claude-sourced rows,
      // newest first — memory is shared across harnesses for the same project.
      const observations = queryObservationsMulti(store, ['context-platform-project'], config);
      expect(observations.map(obs => obs.title)).toEqual(['CLAUDE_CONTEXT_OBS', 'CODEX_CONTEXT_OBS']);

      const summaries = querySummariesMulti(store, ['context-platform-project'], config);
      expect(summaries.map(summary => summary.request)).toEqual(['CLAUDE_CONTEXT_SUMMARY', 'CODEX_CONTEXT_SUMMARY']);

      expect(countObservationsByProjects(store, ['context-platform-project'])).toBe(2);
    } finally {
      store.close();
    }
  });

  it('returns every harness across multi-project context queries', () => {
    const store = new SessionStore(':memory:');
    try {
      seed(store, {
        project: 'context-parent',
        contentSessionId: 'parent-codex',
        memorySessionId: 'parent-codex-memory',
        platformSource: 'codex',
        title: 'PARENT_CODEX_OBS',
        summaryRequest: 'PARENT_CODEX_SUMMARY',
        createdAtEpoch: 1_700_000_000_000,
      });
      seed(store, {
        project: 'context-worktree',
        contentSessionId: 'worktree-codex',
        memorySessionId: 'worktree-codex-memory',
        platformSource: 'codex',
        title: 'WORKTREE_CODEX_OBS',
        summaryRequest: 'WORKTREE_CODEX_SUMMARY',
        createdAtEpoch: 1_700_000_001_000,
      });
      seed(store, {
        project: 'context-worktree',
        contentSessionId: 'worktree-claude',
        memorySessionId: 'worktree-claude-memory',
        platformSource: 'claude',
        title: 'WORKTREE_CLAUDE_OBS',
        summaryRequest: 'WORKTREE_CLAUDE_SUMMARY',
        createdAtEpoch: 1_700_000_002_000,
      });

      const projects = ['context-parent', 'context-worktree'];
      expect(queryObservationsMulti(store, projects, config).map(obs => obs.title)).toEqual([
        'WORKTREE_CLAUDE_OBS',
        'WORKTREE_CODEX_OBS',
        'PARENT_CODEX_OBS',
      ]);
      expect(querySummariesMulti(store, projects, config).map(summary => summary.request)).toEqual([
        'WORKTREE_CLAUDE_SUMMARY',
        'WORKTREE_CODEX_SUMMARY',
        'PARENT_CODEX_SUMMARY',
      ]);
    } finally {
      store.close();
    }
  });
});

describe('session count counts sessions, not summary rows', () => {
  const config: ContextConfig = {
    totalObservationCount: 20,
    fullObservationCount: 3,
    sessionCount: 2,
    showReadTokens: true,
    showWorkTokens: true,
    showSavingsAmount: true,
    showSavingsPercent: true,
    observationTypes: new Set(['discovery']),
    observationConcepts: new Set(['platform-scope']),
    fullObservationField: 'narrative',
    showLastSummary: true,
    showLastMessage: false,
  };

  function seedSummary(
    store: SessionStore,
    memorySessionId: string,
    request: string,
    createdAtEpoch: number,
  ): void {
    store.storeSummary(
      memorySessionId,
      'compaction-heavy',
      {
        request,
        investigated: 'investigated',
        learned: 'learned',
        completed: 'completed',
        next_steps: 'next',
        notes: null,
      },
      1,
      0,
      createdAtEpoch,
    );
  }

  it('returns the newest summary of each distinct session when one session wrote many', () => {
    const store = new SessionStore(':memory:');
    try {
      for (const [index, memorySessionId] of ['mem-old', 'mem-mid', 'mem-new'].entries()) {
        const sessionDbId = store.createSDKSession(`content-${memorySessionId}`, 'compaction-heavy', 'prompt');
        store.ensureMemorySessionIdRegistered(sessionDbId, memorySessionId);
        // The newest session compacted repeatedly: many rows, one session.
        const rows = memorySessionId === 'mem-new' ? 5 : 1;
        for (let row = 0; row < rows; row++) {
          seedSummary(
            store,
            memorySessionId,
            `${memorySessionId.toUpperCase()}_${row}`,
            1_700_000_000_000 + index * 1_000_000 + row * 1_000,
          );
        }
      }

      const summaries = querySummariesMulti(store, ['compaction-heavy'], config);

      // sessionCount 2 = two distinct sessions, newest first, each represented by
      // its latest row -- not five rows of the one session that kept compacting.
      expect(summaries.map(summary => summary.request)).toEqual([
        'MEM-NEW_4',
        'MEM-MID_0',
      ]);
    } finally {
      store.close();
    }
  });
});

describe('concept exact-match injection (#3379)', () => {
  const config: ContextConfig = {
    totalObservationCount: 20,
    fullObservationCount: 3,
    sessionCount: 20,
    showReadTokens: true,
    showWorkTokens: true,
    showSavingsAmount: true,
    showSavingsPercent: true,
    observationTypes: new Set(['discovery']),
    observationConcepts: new Set(['gotcha']),
    fullObservationField: 'narrative',
    showLastSummary: true,
    showLastMessage: false,
  };

  it('excludes a row whose stored concept carries a "keyword: description" prefix', () => {
    // The injection query matches concepts exactly (`WHERE value IN (...)`).
    // A row stored as "gotcha: x" must NOT match — this is the #3379 defect
    // that the parser normalization and the v49 backfill remove at the write
    // side; the query itself intentionally stays exact-match.
    const db = new Database(':memory:');
    try {
      const store = new SessionStore(db);
      const sessionDbId = store.createSDKSession('content-3379', 'concept-project', 'prompt');
      store.ensureMemorySessionIdRegistered(sessionDbId, 'mem-3379');
      // Insert directly: the fresh store is already past v49, so this mimics
      // a malformed row written before the migration existed.
      db.prepare(`
        INSERT INTO observations (memory_session_id, project, type, title, concepts, created_at, created_at_epoch)
        VALUES ('mem-3379', 'concept-project', 'discovery', 'MALFORMED_CONCEPT_OBS', '["gotcha: x"]', ?, ?)
      `).run(new Date().toISOString(), 1_700_000_000_000);

      expect(queryObservationsMulti(store, ['concept-project'], config)).toEqual([]);
    } finally {
      db.close();
    }
  });

  // Fork: DEC-05. The 2026-07-15 prompt change made sparse tagging the norm — "0-2 concepts,
  // only central, empty valid" — and this gate then turned "emitted nothing" into permanent
  // invisibility. 734 rows were unreachable when this was written, 674 of them in ACME.
  // An off-vocabulary tag is still excluded; only the empty answer is let through.
  it.each([
    ['an empty JSON array', '[]'],
    ['an empty string', ''],
    ['NULL', null],
  ])('includes a row whose concepts are %s', (_label, storedConcepts) => {
    const db = new Database(':memory:');
    try {
      const store = new SessionStore(db);
      const sessionDbId = store.createSDKSession('content-dec05', 'concept-project', 'prompt');
      store.ensureMemorySessionIdRegistered(sessionDbId, 'mem-dec05');
      db.prepare(`
        INSERT INTO observations (memory_session_id, project, type, title, concepts, created_at, created_at_epoch)
        VALUES ('mem-dec05', 'concept-project', 'discovery', 'EMPTY_CONCEPT_OBS', ?, ?, ?)
      `).run(storedConcepts, new Date().toISOString(), 1_700_000_000_000);

      const titles = queryObservationsMulti(store, ['concept-project'], config).map(o => o.title);
      expect(titles).toContain('EMPTY_CONCEPT_OBS');
    } finally {
      db.close();
    }
  });
});
