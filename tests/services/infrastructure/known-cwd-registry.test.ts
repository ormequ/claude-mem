import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  listKnownCwds,
  recordCwd,
  resetKnownCwdRegistryCacheForTesting,
} from '../../../src/services/infrastructure/KnownCwdRegistry.js';

// Regression coverage for the discovery half of merged-worktree adoption.
// `adoptMergedWorktreesForAllKnownRepos` used to read its repo list from
// `pending_messages.cwd` — a queue whose rows are deleted once processed, so
// it was empty almost always and adoption silently resolved zero repos.
// This registry is the durable replacement; these tests pin the properties
// adoption depends on.

const tempRoots: string[] = [];

function makeDataDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'claude-mem-known-cwds-'));
  tempRoots.push(root);
  return root;
}

function makeExistingDir(label: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), `claude-mem-cwd-${label}-`));
  tempRoots.push(root);
  return root;
}

function registryFile(dataDir: string): string {
  return path.join(dataDir, 'state', 'known-cwds.json');
}

afterAll(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('KnownCwdRegistry', () => {
  beforeEach(() => {
    resetKnownCwdRegistryCacheForTesting();
  });

  it('persists a recorded cwd so a later process can read it back', () => {
    const dataDir = makeDataDir();
    const cwd = makeExistingDir('a');

    recordCwd(cwd, dataDir);

    // Drop the in-memory cache to prove the value survived to disk — this is
    // the whole point: the worker that records is not the run that adopts.
    resetKnownCwdRegistryCacheForTesting();
    expect(listKnownCwds(dataDir)).toEqual([cwd]);
    expect(existsSync(registryFile(dataDir))).toBe(true);
  });

  it('keeps every distinct cwd and does not duplicate a repeated one', () => {
    const dataDir = makeDataDir();
    const first = makeExistingDir('first');
    const second = makeExistingDir('second');

    recordCwd(first, dataDir);
    recordCwd(second, dataDir);
    recordCwd(first, dataDir);

    resetKnownCwdRegistryCacheForTesting();
    const listed = listKnownCwds(dataDir);
    expect(listed).toHaveLength(2);
    expect(new Set(listed)).toEqual(new Set([first, second]));
  });

  it('ignores empty, blank and non-string cwds', () => {
    const dataDir = makeDataDir();

    recordCwd('', dataDir);
    recordCwd('   ', dataDir);
    recordCwd(null, dataDir);
    recordCwd(undefined, dataDir);

    expect(listKnownCwds(dataDir)).toEqual([]);
  });

  it('prunes cwds whose directory no longer exists (removed worktrees)', () => {
    const dataDir = makeDataDir();
    const alive = makeExistingDir('alive');
    const doomed = makeExistingDir('doomed');

    recordCwd(alive, dataDir);
    recordCwd(doomed, dataDir);
    rmSync(doomed, { recursive: true, force: true });

    resetKnownCwdRegistryCacheForTesting();
    expect(listKnownCwds(dataDir)).toEqual([alive]);
  });

  it('drops a pruned cwd from the file on the next write', () => {
    const dataDir = makeDataDir();
    const alive = makeExistingDir('alive2');
    const doomed = makeExistingDir('doomed2');

    recordCwd(doomed, dataDir);
    rmSync(doomed, { recursive: true, force: true });
    recordCwd(alive, dataDir);

    const payload = JSON.parse(readFileSync(registryFile(dataDir), 'utf-8'));
    expect(payload.cwds).toEqual([alive]);
  });

  it('survives a corrupt registry file instead of throwing at the caller', () => {
    const dataDir = makeDataDir();
    const cwd = makeExistingDir('recover');
    mkdirSync(path.join(dataDir, 'state'), { recursive: true });
    writeFileSync(registryFile(dataDir), '{ this is not json', 'utf-8');

    expect(() => listKnownCwds(dataDir)).not.toThrow();
    expect(listKnownCwds(dataDir)).toEqual([]);

    // And it must recover: a later record rewrites the file cleanly.
    recordCwd(cwd, dataDir);
    resetKnownCwdRegistryCacheForTesting();
    expect(listKnownCwds(dataDir)).toEqual([cwd]);
  });
});
