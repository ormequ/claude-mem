import { describe, expect, it } from 'bun:test';
import { prepareSummariesForTimeline } from '../../src/services/context/ObservationCompiler';
import type { SessionSummary } from '../../src/services/context/types';

function summary(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: 1,
    memory_session_id: 'session-a',
    request: 'Work on the issue',
    investigated: 'Investigated code',
    learned: 'Learned details',
    completed: 'Completed work',
    next_steps: 'Next step',
    created_at: '2026-06-17T12:00:00.000Z',
    created_at_epoch: 1_781_696_400_000,
    ...overrides,
  };
}

describe('summary timeline preparation', () => {
  it('keeps only the latest non-empty summary per memory session', () => {
    const summaries = [
      summary({ id: 13, memory_session_id: 'session-b', created_at_epoch: 1300 }),
      summary({ id: 12, memory_session_id: 'session-a', created_at_epoch: 1200, learned: 'new' }),
      summary({ id: 11, memory_session_id: 'session-a', created_at_epoch: 1100, learned: 'old' }),
      summary({
        id: 10,
        memory_session_id: 'session-c',
        request: 'empty',
        investigated: '',
        learned: '',
        completed: '',
        next_steps: '',
        created_at_epoch: 1000,
      }),
    ];

    const timelineSummaries = prepareSummariesForTimeline(summaries, summaries);

    expect(timelineSummaries.map((item) => item.id)).toEqual([13, 12]);
  });
});
