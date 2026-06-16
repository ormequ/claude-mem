
import path from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, unlinkSync, cpSync, rmSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { CONTEXT_TAG_OPEN, CONTEXT_TAG_CLOSE, injectContextIntoMarkdownFile } from '../../utils/context-injection.js';
import {
  DEFAULT_CLAUDE_MEM_SKILLS,
  shouldInstallAllClaudeMemSkills,
} from './SkillSelection.js';

const OPENCODE_PLUGIN_CONFIG_PATH = './plugins/claude-mem.js';

type OpenCodeConfig = {
  $schema?: string;
  plugin?: unknown;
  [key: string]: unknown;
};

export function getOpenCodeConfigDirectory(): string {
  if (process.env.OPENCODE_CONFIG_DIR) {
    return process.env.OPENCODE_CONFIG_DIR;
  }
  return path.join(homedir(), '.config', 'opencode');
}

export function getOpenCodePluginsDirectory(): string {
  return path.join(getOpenCodeConfigDirectory(), 'plugins');
}

export function getOpenCodeSkillsDirectory(): string {
  return path.join(getOpenCodeConfigDirectory(), 'skills');
}

export function getInstalledSkillsPath(): string {
  return path.join(getOpenCodeSkillsDirectory(), 'claude-mem');
}

export function getOpenCodeConfigPath(): string {
  return path.join(getOpenCodeConfigDirectory(), 'opencode.json');
}

export function getOpenCodeAgentsMdPath(): string {
  return path.join(getOpenCodeConfigDirectory(), 'AGENTS.md');
}

export function getInstalledPluginPath(): string {
  return path.join(getOpenCodePluginsDirectory(), 'claude-mem.js');
}

function getOpenCodePluginEntries(config: OpenCodeConfig): unknown[] {
  if (Array.isArray(config.plugin)) {
    return config.plugin;
  }
  return config.plugin === undefined ? [] : [config.plugin];
}

export function addOpenCodePluginReference(config: OpenCodeConfig): OpenCodeConfig {
  const existingPlugins = getOpenCodePluginEntries(config);
  if (existingPlugins.includes(OPENCODE_PLUGIN_CONFIG_PATH)) {
    return config;
  }

  return {
    ...config,
    plugin: [...existingPlugins, OPENCODE_PLUGIN_CONFIG_PATH],
  };
}

export function removeOpenCodePluginReference(config: OpenCodeConfig): OpenCodeConfig {
  return {
    ...config,
    plugin: getOpenCodePluginEntries(config).filter(
      (plugin) => plugin !== OPENCODE_PLUGIN_CONFIG_PATH,
    ),
  };
}

export function registerOpenCodePluginInConfig(): number {
  const configPath = getOpenCodeConfigPath();
  const defaultConfig: OpenCodeConfig = {
    $schema: 'https://opencode.ai/config.json',
  };

  try {
    const config = existsSync(configPath)
      ? JSON.parse(readFileSync(configPath, 'utf-8')) as OpenCodeConfig
      : defaultConfig;
    const updatedConfig = addOpenCodePluginReference(config);

    writeFileSync(configPath, `${JSON.stringify(updatedConfig, null, 2)}\n`, 'utf-8');
    console.log(`  Plugin registered in: ${configPath}`);
    logger.info('OPENCODE', 'Plugin registered in config', { path: configPath });

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to register OpenCode plugin in config: ${message}`);
    return 1;
  }
}

export function deregisterOpenCodePluginFromConfig(): number {
  const configPath = getOpenCodeConfigPath();
  if (!existsSync(configPath)) {
    return 0;
  }

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as OpenCodeConfig;
    const updatedConfig = removeOpenCodePluginReference(config);

    writeFileSync(configPath, `${JSON.stringify(updatedConfig, null, 2)}\n`, 'utf-8');
    console.log(`  Plugin deregistered from: ${configPath}`);
    logger.info('OPENCODE', 'Plugin deregistered from config', { path: configPath });

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to deregister OpenCode plugin from config: ${message}`);
    return 1;
  }
}

export function findBuiltPluginPath(): string | null {
  const possiblePaths = [
    path.join(
      process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'),
      'plugins', 'marketplaces', 'ormequ',
      'dist', 'opencode-plugin', 'index.js',
    ),
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'opencode-plugin', 'index.js'),
  ];

  for (const candidatePath of possiblePaths) {
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
}

export function findBundledSkillsPath(): string | null {
  const possiblePaths = [
    path.join(
      process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'),
      'plugins', 'marketplaces', 'ormequ',
      'plugin', 'skills',
    ),
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'plugin', 'skills'),
  ];

  for (const candidatePath of possiblePaths) {
    if (existsSync(path.join(candidatePath, 'mem-search', 'SKILL.md'))) {
      return candidatePath;
    }
  }

  return null;
}

function installSelectedOpenCodeSkills(sourcePath: string, destinationPath: string): number {
  let installedCount = 0;
  const skillNames = shouldInstallAllClaudeMemSkills()
    ? null
    : [...DEFAULT_CLAUDE_MEM_SKILLS];

  if (skillNames === null) {
    cpSync(sourcePath, destinationPath, { recursive: true });
    return -1;
  }

  for (const skillName of skillNames) {
    const sourceSkillPath = path.join(sourcePath, skillName);
    if (!existsSync(path.join(sourceSkillPath, 'SKILL.md'))) {
      logger.warn('OPENCODE', 'Default OpenCode skill missing from bundle', { skillName });
      continue;
    }

    cpSync(sourceSkillPath, path.join(destinationPath, skillName), { recursive: true });
    installedCount += 1;
  }

  return installedCount;
}

export function installOpenCodeSkills(): number {
  const skillsSourcePath = findBundledSkillsPath();
  if (!skillsSourcePath) {
    console.error('Could not find bundled claude-mem skills.');
    console.error('  Expected at: plugin/skills');
    return 1;
  }

  const destinationPath = getInstalledSkillsPath();

  try {
    mkdirSync(getOpenCodeSkillsDirectory(), { recursive: true });
    rmSync(destinationPath, { recursive: true, force: true });
    mkdirSync(destinationPath, { recursive: true });
    const installedCount = installSelectedOpenCodeSkills(skillsSourcePath, destinationPath);

    const mode = shouldInstallAllClaudeMemSkills() ? 'all bundled skills' : `${installedCount} default skills`;
    console.log(`  Skills installed to: ${destinationPath} (${mode})`);
    logger.info('OPENCODE', 'Skills installed', {
      source: skillsSourcePath,
      destination: destinationPath,
      mode,
    });

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to install OpenCode skills: ${message}`);
    return 1;
  }
}

export function installOpenCodePlugin(): number {
  const builtPluginPath = findBuiltPluginPath();
  if (!builtPluginPath) {
    console.error('Could not find built OpenCode plugin bundle.');
    console.error('  Expected at: dist/opencode-plugin/index.js');
    console.error('  Run the build first: npm run build');
    return 1;
  }

  const pluginsDirectory = getOpenCodePluginsDirectory();
  const destinationPath = getInstalledPluginPath();

  try {
    mkdirSync(pluginsDirectory, { recursive: true });

    copyFileSync(builtPluginPath, destinationPath);

    console.log(`  Plugin installed to: ${destinationPath}`);
    logger.info('OPENCODE', 'Plugin installed', { destination: destinationPath });

    const registerResult = registerOpenCodePluginInConfig();
    if (registerResult !== 0) {
      return registerResult;
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to install OpenCode plugin: ${message}`);
    return 1;
  }
}

export function injectContextIntoAgentsMd(contextContent: string): number {
  const agentsMdPath = getOpenCodeAgentsMdPath();

  try {
    injectContextIntoMarkdownFile(agentsMdPath, contextContent, '# Claude-Mem Memory Context');
    logger.info('OPENCODE', 'Context injected into AGENTS.md', { path: agentsMdPath });
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to inject context into AGENTS.md: ${message}`);
    return 1;
  }
}

export async function syncContextToAgentsMd(
  port: number,
  project: string,
): Promise<void> {
  try {
    await fetchAndInjectOpenCodeContext(port, project);
  } catch (error) {
    if (error instanceof Error) {
      logger.debug('WORKER', 'Worker not available during context sync', {}, error);
    } else {
      logger.debug('WORKER', 'Worker not available during context sync', {}, new Error(String(error)));
    }
  }
}

async function fetchAndInjectOpenCodeContext(port: number, project: string): Promise<void> {
  const response = await fetch(
    `http://127.0.0.1:${port}/api/context/inject?project=${encodeURIComponent(project)}`,
  );
  if (!response.ok) return;

  const contextText = await response.text();
  if (contextText && contextText.trim()) {
    const injectResult = injectContextIntoAgentsMd(contextText);
    if (injectResult !== 0) {
      logger.warn('OPENCODE', 'Failed to inject context into AGENTS.md during sync');
    }
  }
}

function writeOrRemoveCleanedAgentsMd(agentsMdPath: string, trimmedContent: string): void {
  if (
    trimmedContent.length === 0 ||
    trimmedContent === '# Claude-Mem Memory Context'
  ) {
    unlinkSync(agentsMdPath);
    console.log(`  Removed empty AGENTS.md`);
  } else {
    writeFileSync(agentsMdPath, trimmedContent + '\n', 'utf-8');
    console.log(`  Cleaned context from AGENTS.md`);
  }
}

export function uninstallOpenCodePlugin(): number {
  let hasErrors = false;

  const pluginPath = getInstalledPluginPath();
  if (existsSync(pluginPath)) {
    try {
      unlinkSync(pluginPath);
      console.log(`  Removed plugin: ${pluginPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  Failed to remove plugin: ${message}`);
      hasErrors = true;
    }
  }

  if (deregisterOpenCodePluginFromConfig() !== 0) {
    hasErrors = true;
  }

  const skillsPath = getInstalledSkillsPath();
  if (existsSync(skillsPath)) {
    try {
      rmSync(skillsPath, { recursive: true, force: true });
      console.log(`  Removed skills: ${skillsPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  Failed to remove skills: ${message}`);
      hasErrors = true;
    }
  }

  const agentsMdPath = getOpenCodeAgentsMdPath();
  if (existsSync(agentsMdPath)) {
    let content: string;
    try {
      content = readFileSync(agentsMdPath, 'utf-8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  Failed to read AGENTS.md: ${message}`);
      hasErrors = true;
      content = '';
    }

    const tagStartIndex = content.indexOf(CONTEXT_TAG_OPEN);
    const tagEndIndex = content.indexOf(CONTEXT_TAG_CLOSE);

    if (tagStartIndex !== -1 && tagEndIndex !== -1) {
      content =
        content.slice(0, tagStartIndex).trimEnd() +
        '\n' +
        content.slice(tagEndIndex + CONTEXT_TAG_CLOSE.length).trimStart();

      const trimmedContent = content.trim();
      try {
        writeOrRemoveCleanedAgentsMd(agentsMdPath, trimmedContent);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`  Failed to clean AGENTS.md: ${message}`);
        hasErrors = true;
      }
    }
  }

  return hasErrors ? 1 : 0;
}

export function checkOpenCodeStatus(): number {
  console.log('\nClaude-Mem OpenCode Integration Status\n');

  const configDirectory = getOpenCodeConfigDirectory();
  const pluginPath = getInstalledPluginPath();
  const skillsPath = getInstalledSkillsPath();
  const agentsMdPath = getOpenCodeAgentsMdPath();

  console.log(`Config directory: ${configDirectory}`);
  console.log(`  Exists: ${existsSync(configDirectory) ? 'yes' : 'no'}`);
  console.log('');

  console.log(`Plugin: ${pluginPath}`);
  console.log(`  Installed: ${existsSync(pluginPath) ? 'yes' : 'no'}`);
  console.log('');

  console.log(`Skills: ${skillsPath}`);
  console.log(`  Installed: ${existsSync(path.join(skillsPath, 'mem-search', 'SKILL.md')) ? 'yes' : 'no'}`);
  console.log('');

  console.log(`Context (AGENTS.md): ${agentsMdPath}`);
  if (existsSync(agentsMdPath)) {
    const content = readFileSync(agentsMdPath, 'utf-8');
    const hasContextTags = content.includes(CONTEXT_TAG_OPEN);
    console.log(`  Exists: yes`);
    console.log(`  Has claude-mem context: ${hasContextTags ? 'yes' : 'no'}`);
  } else {
    console.log(`  Exists: no`);
  }

  console.log('');
  return 0;
}

export async function installOpenCodeIntegration(): Promise<number> {
  console.log('\nInstalling Claude-Mem for OpenCode...\n');

  const pluginResult = installOpenCodePlugin();
  if (pluginResult !== 0) {
    return pluginResult;
  }

  const skillsResult = installOpenCodeSkills();
  if (skillsResult !== 0) {
    return skillsResult;
  }

  const contextToInject = `# Claude-Mem Runtime Memory

Claude-Mem memory is shared by workspace project name across Claude Code and OpenCode.
Use claude-mem search tools to retrieve relevant past sessions for the current workspace project.
Do not infer that memory is empty from this file; project-specific memory is served by the OpenCode plugin at runtime.`;

  const injectResult = injectContextIntoAgentsMd(contextToInject);
  if (injectResult !== 0) {
    logger.warn('OPENCODE', 'Failed to inject runtime memory primer into AGENTS.md during install');
  } else {
    console.log('  Runtime memory primer created');
  }

  console.log(`
Installation complete!

Plugin installed to: ${getInstalledPluginPath()}
Skills installed to: ${getInstalledSkillsPath()}
Context file: ${getOpenCodeAgentsMdPath()}

Next steps:
  1. Start claude-mem worker: npx claude-mem start
  2. Restart OpenCode to load the plugin
  3. Memory capture is automatic from then on
`);

  return 0;
}
