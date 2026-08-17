import { afterEach, beforeEach, describe, it, expect } from 'bun:test';

import { ModeManager } from '../../src/services/domain/ModeManager.js';

import { parseAgentXml, filterConcepts } from '../../src/sdk/parser.js';

// Load the real bundled `code` mode rather than mocking ModeManager — see
// tests/sdk/parser.test.ts for why (process-global singleton, leaks across
// files in the same `bun test` run if left un-restored).
ModeManager.getInstance().loadMode('code');

const CANON = ['how-it-works', 'why-it-exists', 'what-changed', 'problem-solution',
               'gotcha', 'pattern', 'trade-off', 'deliberate-decision'];

function xmlWith(concepts: string[]): string {
  const items = concepts.map(c => `<concept>${c}</concept>`).join('');
  return `<observation><type>discovery</type><title>t</title><concepts>${items}</concepts></observation>`;
}

describe('filterConcepts', () => {
  it('splits kept/dropped against the allowed set', () => {
    const r = filterConcepts(['gotcha', 'frontend', 'routing'], new Set(CANON));
    expect(r.kept).toEqual(['gotcha']);
    expect(r.dropped).toEqual(['frontend', 'routing']);
  });

  // Live drop stats 2026-07-30: `how it-works` lost 4 times to exact match.
  it('recovers separator/case slips and stores the canonical spelling', () => {
    const r = filterConcepts(
      ['how it-works', 'Trade_Off', '  GOTCHA  ', 'problem  solution'],
      new Set(CANON),
    );
    expect(r.kept).toEqual(['how-it-works', 'trade-off', 'gotcha', 'problem-solution']);
    expect(r.dropped).toEqual([]);
  });

  it('collapses two spellings of one concept into a single entry', () => {
    const r = filterConcepts(['how-it-works', 'how it works'], new Set(CANON));
    expect(r.kept).toEqual(['how-it-works']);
  });

  it('still drops topic words that only look like separators slips', () => {
    const r = filterConcepts(['data quality', 'security_note'], new Set(CANON));
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual(['data quality', 'security_note']);
  });
});

describe('parseAgentXml concepts whitelist (active mode = code)', () => {
  beforeEach(() => {
    ModeManager.getInstance().loadMode('code');
  });

  it('drops topic words, keeps canonical (incl. deliberate-decision)', () => {
    const res = parseAgentXml(xmlWith(['frontend', 'deliberate-decision', 'bug']));
    expect(res.valid).toBe(true);
    if (res.valid) expect(res.observations[0].concepts).toEqual(['deliberate-decision']);
  });

  it('still removes the observation type from concepts', () => {
    const res = parseAgentXml(xmlWith(['discovery', 'gotcha']));
    expect(res.valid).toBe(true);
    if (res.valid) expect(res.observations[0].concepts).toEqual(['gotcha']);
  });

  it('does not drop the observation when all concepts are filtered (title is content)', () => {
    const res = parseAgentXml(xmlWith(['frontend', 'ui']));
    expect(res.valid).toBe(true);
    if (res.valid) {
      expect(res.observations).toHaveLength(1);
      expect(res.observations[0].concepts).toEqual([]);
    }
  });
});

describe('parseAgentXml concepts whitelist (mode with no vocabulary)', () => {
  beforeEach(() => {
    const modeManager = ModeManager.getInstance() as unknown as { activeMode: unknown };
    modeManager.activeMode = {
      observation_types: [{ id: 'bugfix' }, { id: 'discovery' }, { id: 'refactor' }],
      observation_concepts: [],
    };
  });

  afterEach(() => {
    // Restore a real loaded mode rather than nulling activeMode:
    // ModeManager.getActiveMode() throws 'No mode loaded' when activeMode is
    // null, and ModeManager is a process-global singleton shared across all
    // test files in one `bun test` run — leaving it null here would land a
    // cryptic failure on any later-running file that reaches getActiveMode()
    // without its own loadMode() call.
    ModeManager.getInstance().loadMode('code');
  });

  it('passes concepts through unfiltered when the mode declares no vocabulary', () => {
    const res = parseAgentXml(xmlWith(['frontend', 'routing', 'gotcha']));
    expect(res.valid).toBe(true);
    if (res.valid) expect(res.observations[0].concepts).toEqual(['frontend', 'routing', 'gotcha']);
  });
});

// gpt-5.6-luna closes <concepts> with </concept> in 1-31% of its blocks
// (measured over a replayed day, 2026-08-16). The container close used to be
// mandatory, so every concept in such a block was silently lost.
describe('malformed container close', () => {
  it('keeps concepts when </concepts> is written as </concept>', () => {
    const xml = `<observation><type>discovery</type><title>t</title>
  <concepts>
    <concept>gotcha</concept>
    <concept>pattern</concept>
  </concept>
  <files_read><file>a.ts</file></files_read>
</observation>`;
    const parsed = parseAgentXml(xml);
    expect(parsed.observations[0].concepts).toEqual(['gotcha', 'pattern']);
    expect(parsed.observations[0].files_read).toEqual(['a.ts']);
  });

  it('does not spill a sibling list into an unterminated one', () => {
    const xml = `<observation><type>discovery</type><title>t</title>
  <files_read><file>a.ts</file>
  <files_modified><file>b.ts</file></files_modified>
</observation>`;
    const parsed = parseAgentXml(xml);
    expect(parsed.observations[0].files_read).toEqual(['a.ts']);
    expect(parsed.observations[0].files_modified).toEqual(['b.ts']);
  });
});
