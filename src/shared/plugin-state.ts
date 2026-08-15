
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger.js';
import { parseJsonWithBom } from './atomic-json.js';

const PLUGIN_SETTINGS_KEYS = ['claude-mem@ormequ', 'claude-mem@thedotmack'];

export function isPluginDisabledInClaudeSettings(): boolean {
  try {
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const settingsPath = join(claudeConfigDir, 'settings.json');
    if (!existsSync(settingsPath)) return false;
    const raw = readFileSync(settingsPath, 'utf-8');
    const settings = parseJsonWithBom<Record<string, any>>(raw);
    return PLUGIN_SETTINGS_KEYS.some((key) => settings?.enabledPlugins?.[key] === false);
  } catch (error: unknown) {
    logger.error('CONFIG', 'Failed to read Claude settings', { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
