// Fork contract (fork-notes/install-defaults.md): the installer never signs in
// to cmem.ai, never offers the CMEM Pro trial, never sends a usage summary, and
// never defaults memory to the Anthropic plan. Upstream's OAuth/trial code stays
// in place behind CMEM_ACCOUNT_LOGIN_ENABLED, so these checks pin the gates.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const source = readFileSync(join(__dirname, '..', '..', 'src', 'npx-cli', 'commands', 'install.ts'), 'utf-8');

describe('fork installer: no cmem.ai account', () => {
  it('keeps the account gate off', () => {
    expect(source).toContain('const CMEM_ACCOUNT_LOGIN_ENABLED = false;');
  });

  it('skips the blocking OAuth login whenever the gate is off', () => {
    const gate = source.slice(
      source.indexOf('let oauthPairing: InstallerOAuthPairing | null = null;'),
      source.indexOf('oauthPairing = await requireInstallerOAuthLogin(version);'),
    );
    expect(gate).toContain('} else if (!CMEM_ACCOUNT_LOGIN_ENABLED) {');
  });

  it('never prints the deferred sign-in link', () => {
    expect(source).toContain('if (CMEM_ACCOUNT_LOGIN_ENABLED) await offerDeferredLogin(options, version);');
  });

  it('pitches no trial and claims no cmem.ai contact on the last screen', () => {
    expect(source).not.toContain('PRO_TRIAL_PITCH');
    expect(source).not.toContain('cmem.ai is contacted once');
  });

  it('defaults a non-interactive run to openai-compatible, not the Anthropic plan', () => {
    const fn = source.slice(
      source.indexOf('export function validateNonInteractiveProvider('),
      source.indexOf('export async function runInstallCommand('),
    );
    expect(fn).toContain("options.provider = 'openai-compatible';");
    expect(fn).not.toContain("options.provider = 'claude';");
  });
});
