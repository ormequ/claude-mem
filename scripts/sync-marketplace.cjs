#!/usr/bin/env node

const { execSync } = require('child_process');
const { existsSync, readFileSync, readdirSync, rmSync, statSync, copyFileSync } = require('fs');
const path = require('path');
const os = require('os');

// Keep in sync with SkillSelection.ts (DEFAULT_CLAUDE_MEM_SKILLS / COMPACT_CLAUDE_MEM_SKILLS).
const DEFAULT_CLAUDE_MEM_SKILLS = [
  'mem-search', 'smart-explore', 'learn-codebase', 'how-it-works',
  'timeline-report', 'weekly-digests', 'standup', 'pathfinder',
  'knowledge-agent',
];
const COMPACT_CLAUDE_MEM_SKILLS = ['knowledge-agent', 'mem-search', 'pathfinder'];

// Mirror resolveClaudeMemSkillSet() in SkillSelection.ts.
function resolveSkillSet() {
  const explicit = process.env.CLAUDE_MEM_SKILL_SET?.trim().toLowerCase();
  if (explicit === 'default' || explicit === 'compact' || explicit === 'full') return explicit;
  if (process.env.CLAUDE_MEM_INSTALL_ALL_SKILLS?.trim().toLowerCase() === 'true') return 'full';
  return 'default';
}

// Mirror `npx claude-mem install` skill filtering: dev sync copies plugin/ wholesale,
// so without this the marketplace/cache get all skills (e.g. /design-is) regardless.
function filterSkills(skillsDir) {
  const set = resolveSkillSet();
  if (set === 'full') return;
  if (!existsSync(skillsDir)) return;
  const allowed = new Set(set === 'compact' ? COMPACT_CLAUDE_MEM_SKILLS : DEFAULT_CLAUDE_MEM_SKILLS);
  for (const entry of readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    if (statSync(entryPath).isDirectory() && !allowed.has(entry)) {
      rmSync(entryPath, { recursive: true, force: true });
    }
  }
}

const INSTALLED_PATH = path.join(os.homedir(), '.claude', 'plugins', 'marketplaces', 'ormequ');
const CACHE_BASE_PATH = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'ormequ', 'claude-mem');

function getCurrentBranch() {
  try {
    if (!existsSync(path.join(INSTALLED_PATH, '.git'))) {
      return null;
    }
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: INSTALLED_PATH,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch {
    return null;
  }
}

function getGitignoreExcludes(basePath) {
  const gitignorePath = path.join(basePath, '.gitignore');
  if (!existsSync(gitignorePath)) return '';

  const syncManagedFiles = new Set();

  const lines = readFileSync(gitignorePath, 'utf-8').split('\n');
  return lines
    .map(line => line.trim())
    .filter(line =>
      line &&
      !line.startsWith('#') &&
      !line.startsWith('!') &&
      !syncManagedFiles.has(line)
    )
    .map(pattern => `--exclude=${JSON.stringify(pattern)}`)
    .join(' ');
}

const branch = getCurrentBranch();
const isForce = process.argv.includes('--force');

if (branch && branch !== 'main' && !isForce) {
  console.log('');
  console.log('\x1b[33m%s\x1b[0m', `WARNING: Installed plugin is on beta branch: ${branch}`);
  console.log('\x1b[33m%s\x1b[0m', 'Running rsync would overwrite beta code.');
  console.log('');
  console.log('Options:');
  console.log('  1. Use the claude-mem UI on the configured worker port to update beta');
  console.log('  2. Switch to stable in UI first, then run sync');
  console.log('  3. Force rsync: npm run sync-marketplace:force');
  console.log('');
  process.exit(1);
}

function getPluginVersion() {
  try {
    const pluginJsonPath = path.join(__dirname, '..', 'plugin', '.claude-plugin', 'plugin.json');
    const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
    return pluginJson.version;
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', 'Failed to read plugin version:', error.message);
    process.exit(1);
  }
}

function parseWorkerPort(rawPort) {
  const port = Number.parseInt(String(rawPort ?? ''), 10);
  return Number.isFinite(port) && port > 0 ? port : null;
}

function detectInstalledVersion(buildVersion) {
  const dataDir = process.env.CLAUDE_MEM_DATA_DIR || path.join(os.homedir(), '.claude-mem');
  const settingsPath = path.join(dataDir, 'settings.json');
  let port = parseWorkerPort(process.env.CLAUDE_MEM_WORKER_PORT);
  if (!port && existsSync(settingsPath)) {
    try {
      const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
      const settingsPort = parseWorkerPort(s.CLAUDE_MEM_WORKER_PORT);
      if (settingsPort) port = settingsPort;
    } catch {}
  }
  if (!port) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 77;
    port = 37700 + (uid % 100);
  }
  let healthBody;
  try {
    healthBody = execSync(`curl -s --max-time 2 http://127.0.0.1:${port}/api/health`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch {
    return null;
  }
  if (!healthBody) return null;
  let installedVersion;
  let installedPath;
  try {
    const j = JSON.parse(healthBody);
    installedVersion = j.version;
    installedPath = j.workerPath;
  } catch {
    return null;
  }
  if (!installedVersion || installedVersion === buildVersion) return null;
  return { installedVersion, installedPath };
}

const installedMismatch = detectInstalledVersion(getPluginVersion());
if (installedMismatch) {
  console.log('');
  console.log('\x1b[33m%s\x1b[0m', 'Version mismatch detected:');
  console.log(`  Building:   ${getPluginVersion()}`);
  console.log(`  Installed:  ${installedMismatch.installedVersion}`);
  if (installedMismatch.installedPath) console.log(`  Worker path: ${installedMismatch.installedPath}`);
  console.log('');
  console.log('Claude Code is pinned to the installed version, so the worker loads from');
  console.log(`its cache dir. Mirroring this build into the installed-version cache so the`);
  console.log('worker restart picks up new code without a Claude Code session restart.');
  console.log('');
  console.log('\x1b[36m%s\x1b[0m', `For a formal version bump, run \`claude plugin update ormequ/claude-mem\``);
  console.log('\x1b[36m%s\x1b[0m', `and restart Claude Code so it loads the ${getPluginVersion()} cache dir.`);
  console.log('');
}
console.log('Syncing to marketplace...');
try {
  const rootDir = path.join(__dirname, '..');
  const gitignoreExcludes = getGitignoreExcludes(rootDir);

  execSync(
    `rsync -av --delete --exclude=.git --exclude=bun.lock --exclude=package-lock.json --exclude=scripts/package.json --exclude=scripts/node_modules ${gitignoreExcludes} ./ ~/.claude/plugins/marketplaces/ormequ/`,
    { stdio: 'inherit' }
  );

  console.log('Running bun install in marketplace...');
  execSync(
    'cd ~/.claude/plugins/marketplaces/ormequ/ && bun install',
    { stdio: 'inherit' }
  );

  const version = getPluginVersion();
  // Claude Code normalizes semver build-metadata '+' to '-' in the cache dir name,
  // so the canonical loaded dir uses '-'. But installed_plugins.json has been seen
  // in the wild with the raw '+' installPath (cache-shadowing gotcha) — the '+' dir
  // is then the one Claude actually loads. Target the normalized dir always, plus
  // the raw '+' dir when it already exists on disk (i.e. some install points at it).
  // We don't create a '+' dir that doesn't exist, to avoid minting phantoms.
  const cacheVersionNames = new Set([version.replace(/\+/g, '-')]);
  if (existsSync(path.join(CACHE_BASE_PATH, version))) {
    cacheVersionNames.add(version);
  }

  const pluginDir = path.join(rootDir, 'plugin');
  const pluginGitignoreExcludes = getGitignoreExcludes(pluginDir);
  // rsync's gitignore excludes drop tracked-but-ignored files. plugin/.mcp.json is
  // force-tracked but matched by the root .gitignore `.mcp.json` line, so it never
  // reaches the copy — and without it Claude Code doesn't register the MCP server
  // when the marketplace points at this copy. Restore it explicitly.
  const mcpSrc = path.join(rootDir, 'plugin', '.mcp.json');

  for (const cacheName of cacheVersionNames) {
    const cachePath = path.join(CACHE_BASE_PATH, cacheName);

    console.log(`Syncing to cache folder (${cacheName})...`);
    execSync(
      `rsync -av --delete --exclude=.git ${pluginGitignoreExcludes} plugin/ "${cachePath}/"`,
      { stdio: 'inherit' }
    );

    console.log(`Running bun install in cache folder (${cacheName})...`);
    execSync(`bun install`, { cwd: cachePath, stdio: 'inherit' });

    filterSkills(path.join(cachePath, 'skills'));

    if (existsSync(mcpSrc)) {
      copyFileSync(mcpSrc, path.join(cachePath, '.mcp.json'));
    }
  }

  filterSkills(path.join(INSTALLED_PATH, 'plugin', 'skills'));
  if (existsSync(mcpSrc)) {
    copyFileSync(mcpSrc, path.join(INSTALLED_PATH, 'plugin', '.mcp.json'));
  }

  console.log('\x1b[32m%s\x1b[0m', 'Sync complete!');

} catch (error) {
  console.error('\x1b[31m%s\x1b[0m', 'Sync failed:', error.message);
  process.exit(1);
}
