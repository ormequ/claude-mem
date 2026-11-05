// `--provider codex` is a bring-your-own option, like `--provider gemini`. It
// must not change the sign-in funnel: the interactive menu stays CMEM Pro
// (pre-selected) and Claude, and a Codex install signs in like any other
// bring-your-own provider. #4216 had exempted it from the sign-in (Wave 3 gate
// R4-4); the plan's verdict for that PR was "flag + viewer only".
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const installSource = readFileSync(join(__dirname, '..', '..', 'src', 'npx-cli', 'commands', 'install.ts'), 'utf-8');

describe('Codex install keeps the sign-in funnel', () => {
  // Fork: the menu offers no CMEM Pro row (it needs a cmem.ai account).
  it('offers bring-your-own providers and Claude, never CMEM Pro', () => {
    const start = installSource.indexOf('await p.multiselect<ProviderChoice>(');
    expect(start).toBeGreaterThan(-1);
    const menu = installSource.slice(start, installSource.indexOf('required: true', start));
    expect(menu).not.toContain("{ value: 'cmem'");
    expect(menu).toContain("{ value: 'claude'");
    expect(menu).toContain("{ value: 'openai-compatible'");
    expect(menu).not.toContain('codex');
  });
});
