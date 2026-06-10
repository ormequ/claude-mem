import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('worker daemon spawn fork fix', () => {
  it('detaches Bun while running worker-service in foreground server mode on Unix', () => {
    const source = readFileSync(
      new URL('../../src/services/infrastructure/ProcessManager.ts', import.meta.url),
      'utf-8',
    );

    expect(source).toContain("const args = useSetsid\n    ? [runtimePath, scriptPath]\n    : [scriptPath];");
  });
});
