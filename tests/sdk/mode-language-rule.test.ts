import { describe, it, expect } from 'bun:test';

import { ModeManager } from '../../src/services/domain/ModeManager.js';

// Fork: the LANGUAGE rule ("write the observation in English, other languages
// only inside verbatim quotes and identifiers") exists because retrieval embeds
// English — a Russian narrative is stored but effectively unfindable.
//
// It lives inside `recording_focus`, and deepMerge replaces strings wholesale,
// so any variant that overrides `recording_focus` for its own tone silently
// drops the rule. `code--chill` did exactly that until 2026-08-17.
const MARKER = 'Retrieval embeds English';

describe('English-output rule survives mode inheritance', () => {
  for (const modeId of ['code', 'code--chill']) {
    it(`${modeId} states it`, () => {
      const mode = ModeManager.getInstance().loadMode(modeId);
      expect(mode.prompts.recording_focus).toContain(MARKER);
    });
  }
});
