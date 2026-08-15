// Fork-owned. Stamps every observation with the extraction prompt that produced it.
//
// Kept out of ResponseProcessor (an upstream file) on purpose: fork-authored logic lives in
// fork-owned modules so an upstream touch is an import conflict, not a hand-port. Same reason
// `file-staleness.ts` and `ChromaMergeDrain.ts` are separate. See FORK_NOTES.md.

import { logger } from '../../../utils/logger.js';
import { ModeManager } from '../../domain/ModeManager.js';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../shared/paths.js';

// `<mode id>@<version>`, e.g. `code@1.1.0`. The mode id comes from settings rather than
// `mode.name`, which is a display string ("Code Development") and differs per translation
// override; the id is what identifies the prompt that actually ran.
export function getPromptVersionTag(): string | null {
  try {
    const version = ModeManager.getInstance().getActiveMode().version;
    if (!version) return null;

    const modeId = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH).CLAUDE_MEM_MODE || 'code';
    return `${modeId}@${version}`;
  } catch (error: unknown) {
    // A missing tag costs one GROUP BY dimension; a throw here would cost the observation.
    logger.debug('DB', 'Could not resolve prompt_version tag', {}, error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}

// Written, not merged: only the observer path calls this, and its observations come from the
// XML parser, which carries no metadata of its own. The API and server-beta paths set their
// own metadata keys through a different call and are untouched.
export function buildObservationMetadata(promptVersion: string | null): string | null {
  return promptVersion ? JSON.stringify({ prompt_version: promptVersion }) : null;
}
