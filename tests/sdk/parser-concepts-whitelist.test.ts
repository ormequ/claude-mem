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
    const modeManager = ModeManager.getInstance() as unknown as { activeMode: unknown };
    modeManager.activeMode = null;
  });

  it('passes concepts through unfiltered when the mode declares no vocabulary', () => {
    const res = parseAgentXml(xmlWith(['frontend', 'routing', 'gotcha']));
    expect(res.valid).toBe(true);
    if (res.valid) expect(res.observations[0].concepts).toEqual(['frontend', 'routing', 'gotcha']);
  });
});
