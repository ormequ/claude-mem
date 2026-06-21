import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';

// Read-side adoption scoping: `adopt` soft-merges worktree observations by
// setting the `merged_into_project` pointer without rewriting the raw `project`
// column. The session-start inject path honors that pointer
// (`project = ? OR merged_into_project = ?`), but search / build_corpus went
// through buildFilterClause, which only matched the raw `project` column — so
// adopted worktree rows were invisible to manual search scoped to the parent.
// These tests pin the inclusive behavior so search mirrors inject.
describe('search merged_into_project (adopt) scoping', () => {
  let store: SessionStore;
  let search: SessionSearch;

  function seedObservation(
    contentSessionId: string,
    memorySessionId: string,
    project: string,
    title: string,
    narrative: string,
  ): void {
    const sdkId = store.createSDKSession(contentSessionId, project, 'prompt', undefined, 'claude');
    store.ensureMemorySessionIdRegistered(sdkId, memorySessionId);
    store.storeObservation(memorySessionId, project, {
      type: 'discovery',
      title,
      subtitle: null,
      facts: [],
      narrative,
      concepts: [],
      files_read: [],
      files_modified: [],
    }, 1);
  }

  // Mirror WorktreeAdoption: soft-merge by setting the pointer, never rewriting
  // the raw project column.
  function adopt(fromProject: string, intoProject: string): void {
    store.db.run(
      'UPDATE observations SET merged_into_project = ? WHERE project = ? AND merged_into_project IS NULL',
      [intoProject, fromProject],
    );
  }

  beforeEach(() => {
    store = new SessionStore(':memory:');
    search = new SessionSearch(store.db);

    // Adopted worktree row: raw project stays composite, pointer -> parent.
    seedObservation('wt-sess', 'wt-mem', 'kedo/kedo', 'Worktree finding', 'shared adoption keyword from worktree');
    // Native parent-repo row.
    seedObservation('parent-sess', 'parent-mem', 'kedo', 'Parent finding', 'shared adoption keyword from parent');
    // Unrelated foreign project: must never leak into a kedo-scoped search.
    seedObservation('other-sess', 'other-mem', 'wp-rosreestr-plugin', 'Foreign finding', 'shared adoption keyword from foreign');

    adopt('kedo/kedo', 'kedo');
  });

  afterEach(() => {
    store.close();
  });

  it('includes adopted worktree rows when scoped to the parent project (FTS path)', () => {
    const results = search.searchObservations('adoption', { project: 'kedo' });
    const titles = results.map(r => r.title).sort();
    expect(titles).toEqual(['Parent finding', 'Worktree finding']);
  });

  it('includes adopted worktree rows on the no-query (filter-only) path too', () => {
    const results = search.searchObservations(undefined, { project: 'kedo' });
    const titles = results.map(r => r.title).sort();
    expect(titles).toEqual(['Parent finding', 'Worktree finding']);
  });

  it('does not leak unrelated foreign projects into a parent-scoped search', () => {
    const results = search.searchObservations('adoption', { project: 'kedo' });
    expect(results.some(r => r.title === 'Foreign finding')).toBe(false);
  });

  it('still matches the composite project key directly (provenance preserved)', () => {
    const results = search.searchObservations('adoption', { project: 'kedo/kedo' });
    const titles = results.map(r => r.title);
    expect(titles).toEqual(['Worktree finding']);
  });
});
