import { describe, it, expect } from 'bun:test';
import { deduplicateObservations, type ObservationRow } from '../../src/cli/handlers/file-context.js';

const TARGET = 'resources/js/Pages/Dev/Gallery.vue';

function obs(over: Partial<ObservationRow> & { id: number }): ObservationRow {
  return {
    memory_session_id: 's1',
    title: `Observation ${over.id}`,
    type: 'discovery',
    created_at_epoch: 1_700_000_000_000 + over.id * 60_000,
    files_read: null,
    files_modified: JSON.stringify([TARGET]),
    concepts: JSON.stringify(['what-changed']),
    ...over,
  };
}

describe('deduplicateObservations — fork concepts boost', () => {
  it('collapses exact re-captures by normalized title, keeps distinct titles', () => {
    const rows = [
      obs({ id: 1, title: 'Fixed the   thing' }),
      obs({ id: 2, title: 'fixed the thing' }), // same after normalization
      obs({ id: 3, title: 'Another finding' }),
    ];
    const ranked = deduplicateObservations(rows, TARGET, 15);
    expect(ranked.map(o => o.id).sort()).toEqual([1, 3]);
  });

  it('keeps rows with null titles distinct (no accidental collapse)', () => {
    const rows = [obs({ id: 1, title: null }), obs({ id: 2, title: null })];
    expect(deduplicateObservations(rows, TARGET, 15)).toHaveLength(2);
  });

  it('boosts decision-carrying concepts over chronicle noise under the cap (killer #24717 class)', () => {
    // 16 newer chronicle entries + 1 old revert with a decision concept.
    // Without the boost the revert would be squeezed out of the top 15
    // when specificity ties.
    const chronicle = Array.from({ length: 16 }, (_, i) =>
      obs({ id: 100 + i, concepts: JSON.stringify(['what-changed']) }));
    const revert = obs({
      id: 1,
      type: 'change',
      title: 'Gallery Close Button Position Reverted',
      concepts: JSON.stringify(['decision', 'what-changed']),
      created_at_epoch: 1_600_000_000_000, // oldest of all
    });
    const ranked = deduplicateObservations([...chronicle, revert], TARGET, 15);
    expect(ranked.map(o => o.id)).toContain(1);
  });

  it('never uses type as a filter: low-priority type with boosted concept survives', () => {
    const ranked = deduplicateObservations(
      [obs({ id: 1, type: 'change', concepts: JSON.stringify(['gotcha']) })],
      TARGET, 15,
    );
    expect(ranked).toHaveLength(1);
  });

  it('prefers observations that modified the target file with a small file set', () => {
    const specific = obs({ id: 1, files_modified: JSON.stringify([TARGET]) });
    const broad = obs({
      id: 2,
      files_modified: JSON.stringify(Array.from({ length: 12 }, (_, i) => `f${i}.ts`)),
      files_read: JSON.stringify([TARGET]),
    });
    const filler = Array.from({ length: 14 }, (_, i) => obs({ id: 100 + i }));
    const ranked = deduplicateObservations([broad, specific, ...filler], TARGET, 15);
    expect(ranked.map(o => o.id)).toContain(1);
  });

  it('respects the display limit', () => {
    const rows = Array.from({ length: 40 }, (_, i) => obs({ id: i + 1, title: `t${i}` }));
    expect(deduplicateObservations(rows, TARGET, 15)).toHaveLength(15);
  });
});
