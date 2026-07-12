// Bug 1 (read-hook-delivery-reliability): the per-file context lookup scoped
// ONLY on the raw `project` column, so worktree observations soft-merged via
// merged_into_project were invisible to a Read from the main checkout — exactly
// the feature-work the hook exists to surface. This mirrors the pointer-aware
// scoping already used by inject (ObservationCompiler) and search (SessionSearch).

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { getObservationsByFilePath } from '../../../src/services/sqlite/observations/get.js';

describe('getObservationsByFilePath — merged_into_project scoping (Bug 1)', () => {
  let store: SessionStore;
  const filePath = 'app/Services/Bitrix24/AbsencesImporter.php';

  function seed(project: string, suffix: string): number {
    const sdkId = store.createSDKSession(`content-${suffix}`, project, 'prompt');
    store.updateMemorySessionId(sdkId, `session-${suffix}`);
    const result = store.storeObservations(
      `session-${suffix}`,
      project,
      [{
        type: 'bugfix',
        title: `touched ${filePath} in ${project}`,
        subtitle: null,
        facts: ['fact'],
        narrative: null,
        concepts: [],
        files_read: [],
        files_modified: [filePath],
      }],
      null,
      0,
      0,
      1_700_000_000_000,
    );
    return result.observationIds[0];
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
  });

  afterEach(() => {
    store.close();
  });

  it('surfaces an adopted worktree observation when scoped to the parent project', () => {
    const id = seed('kedo/bitrix24-deferred-absences', 'wt');
    adopt('kedo/bitrix24-deferred-absences', 'kedo');

    const matches = getObservationsByFilePath(store.db, filePath, { projects: ['kedo'] });
    expect(matches.map(o => o.id)).toContain(id);
  });

  it('still matches the composite slug directly (provenance preserved)', () => {
    const id = seed('kedo/bitrix24-deferred-absences', 'wt2');
    adopt('kedo/bitrix24-deferred-absences', 'kedo');

    const direct = getObservationsByFilePath(store.db, filePath, {
      projects: ['kedo/bitrix24-deferred-absences'],
    });
    expect(direct.map(o => o.id)).toContain(id);
  });

  it('does not leak an unrelated foreign project into a parent-scoped lookup', () => {
    const foreign = seed('wp-rosreestr-plugin', 'foreign');
    const matches = getObservationsByFilePath(store.db, filePath, { projects: ['kedo'] });
    expect(matches.map(o => o.id)).not.toContain(foreign);
  });
});
