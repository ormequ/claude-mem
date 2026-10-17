import { SettingsDefaultsManager } from './SettingsDefaultsManager.js';
import { paths } from './paths.js';
import { logger } from '../utils/logger.js';

const PINNABLE_PROVIDERS = ['claude', 'gemini', 'openrouter', 'codex', 'openai-compatible'] as const;
export type PinnableProvider = typeof PINNABLE_PROVIDERS[number];

/**
 * Fork: CLAUDE_MEM_PROJECT_PROVIDERS pins a project to one provider, e.g.
 * {"personal":"claude"} keeps that project's memory on the Claude plan while
 * every other project follows CLAUDE_MEM_PROVIDER. A key also covers the
 * project's worktrees (`personal/<worktree>`). A pinned project bypasses every
 * fallback, so its data never reaches a provider it was not pinned to.
 */
export function pinnedProviderFor(project: string | null | undefined): PinnableProvider | null {
  if (!project) return null;
  // settings.json may hold it as a JSON string or as a native JSON object.
  let pins: unknown = SettingsDefaultsManager.loadFromFile(paths.settings()).CLAUDE_MEM_PROJECT_PROVIDERS;
  if (typeof pins === 'string') {
    try {
      pins = JSON.parse(pins.trim() || '{}');
    } catch {
      logger.warn('SESSION', 'CLAUDE_MEM_PROJECT_PROVIDERS is not valid JSON; no project is pinned', {});
      return null;
    }
  }
  if (!pins || typeof pins !== 'object' || Array.isArray(pins)) return null;
  for (const [key, provider] of Object.entries(pins)) {
    if ((project === key || project.startsWith(`${key}/`)) && (PINNABLE_PROVIDERS as readonly unknown[]).includes(provider)) {
      return provider as PinnableProvider;
    }
  }
  return null;
}
