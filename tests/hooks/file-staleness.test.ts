import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { getContentStaleThresholdMs } from '../../src/cli/handlers/file-staleness.js';

const COMMIT_EPOCH_S = 1_700_000_000; // fixed past commit time
let repo: string;

function git(args: string[], env: Record<string, string> = {}) {
  execFileSync('git', args, {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: `${COMMIT_EPOCH_S} +0000`,
      GIT_COMMITTER_DATE: `${COMMIT_EPOCH_S} +0000`,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'stale-test-'));
  git(['init', '-q']);
  writeFileSync(join(repo, 'a.txt'), 'committed content\n');
  git(['add', 'a.txt']);
  git(['commit', '-q', '-m', 'initial']);
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('getContentStaleThresholdMs', () => {
  it('returns last commit time for a clean tracked file, ignoring a newer mtime', () => {
    const abs = join(repo, 'a.txt');
    const now = Date.now();
    utimesSync(abs, now / 1000, now / 1000); // simulate checkout/merge bumping mtime
    const threshold = getContentStaleThresholdMs(abs, repo, now);
    expect(threshold).toBe(COMMIT_EPOCH_S * 1000);
  });

  it('falls back to mtime for a dirty file', () => {
    const abs = join(repo, 'a.txt');
    writeFileSync(abs, 'uncommitted edit\n');
    const mtime = 1_800_000_000_000;
    expect(getContentStaleThresholdMs(abs, repo, mtime)).toBe(mtime);
    // restore clean state for other tests
    git(['checkout', '-q', '--', 'a.txt']);
  });

  it('falls back to mtime for an untracked file', () => {
    const abs = join(repo, 'new.txt');
    writeFileSync(abs, 'untracked\n');
    const mtime = 1_800_000_000_000;
    expect(getContentStaleThresholdMs(abs, repo, mtime)).toBe(mtime);
  });

  it('falls back to mtime outside a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'norepo-'));
    const abs = join(dir, 'f.txt');
    writeFileSync(abs, 'x');
    const mtime = 1_800_000_000_000;
    expect(getContentStaleThresholdMs(abs, dir, mtime)).toBe(mtime);
    rmSync(dir, { recursive: true, force: true });
  });
});
