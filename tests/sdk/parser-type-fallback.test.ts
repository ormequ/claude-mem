import { afterEach, beforeEach, describe, it, expect } from 'bun:test';

import { ModeManager } from '../../src/services/domain/ModeManager.js';

import { parseAgentXml } from '../../src/sdk/parser.js';

// These run against the REAL bundled `code` mode, because what is under test is the
// interaction between the mode's declared type list and the parser's fallback — a stub
// with a hand-picked type list would assert nothing about the shipped configuration.
beforeEach(() => {
  ModeManager.getInstance().loadMode('code');
});

afterEach(() => {
  const modeManager = ModeManager.getInstance() as unknown as { activeMode: unknown };
  modeManager.activeMode = null;
});

function firstObservation(raw: string) {
  const result = parseAgentXml(raw);
  if (!result.valid) throw new Error('expected valid observation, got invalid result');
  if (result.summary !== null) throw new Error('expected observation result, got a summary');
  return result.observations[0];
}

describe('observation type fallback', () => {
  // Regression: the fallback was validTypes[0], which is `bugfix` in the code mode, so an
  // observation the model emitted without a <type> was stored as a bug fix. That produced
  // the store's 78 empty-title `bugfix` rows and made the type useless as a filter.
  it('falls back to `change`, not `bugfix`, when the model emits no type', () => {
    const obs = firstObservation(`<observation>
      <title>Worker restarted after config reload</title>
      <narrative>The worker picked up the new mode file on restart.</narrative>
    </observation>`);

    expect(obs.type).toBe('change');
  });

  it('keeps an explicitly emitted type', () => {
    const obs = firstObservation(`<observation>
      <type>bugfix</type>
      <title>Fixed the stale pin</title>
      <narrative>The project pin no longer lapses in non-interactive sessions.</narrative>
    </observation>`);

    expect(obs.type).toBe('bugfix');
  });

  // Regression: an off-vocabulary type used to be stored as emitted. The model invents them
  // at scale, and an invented type is dropped silently by every consumer filtering on type.
  it('coerces a type the mode does not declare', () => {
    const obs = firstObservation(`<observation>
      <type>handler_16_completion_phase_2_transition</type>
      <title>Handler moved to phase 2</title>
      <narrative>The transition landed without a rewrite.</narrative>
    </observation>`);

    expect(obs.type).toBe('change');
  });

  // The two types added 2026-08-03. `finding` separates a conclusion from the discovery that
  // led to it; `failed_attempt` is the only record of a dead end, and nothing else captures it.
  it.each(['finding', 'failed_attempt'])('accepts the %s type', (type) => {
    const declared = ModeManager.getInstance().getActiveMode().observation_types.map(t => t.id);
    expect(declared).toContain(type);

    const obs = firstObservation(`<observation>
      <type>${type}</type>
      <title>Certificates rotate through mk-pki</title>
      <narrative>The cert-manager CRDs in the chart are unused.</narrative>
    </observation>`);

    expect(obs.type).toBe(type);
  });
});
