import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile, unfoldSymbol } from '../../src/services/smart-file-read/parser.js';
import { searchCodebase, formatSearchResults } from '../../src/services/smart-file-read/search.js';

describe('smart-file-read fork fixes', () => {
  let previousXdgCacheHome: string | undefined;
  let treeSitterCacheDir: string;

  beforeEach(() => {
    previousXdgCacheHome = process.env.XDG_CACHE_HOME;
    treeSitterCacheDir = mkdtempSync(join(tmpdir(), 'cmem-tree-sitter-cache-'));
    process.env.XDG_CACHE_HOME = treeSitterCacheDir;
  });

  afterEach(() => {
    if (previousXdgCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = previousXdgCacheHome;
    }
    rmSync(treeSitterCacheDir, { recursive: true, force: true });
  });

  it('keeps folded file views for file path matches when symbols do not match', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cmem-smart-search-'));
    try {
      writeFileSync(join(root, 'grpcutil.go'), [
        'package grpcutil',
        '',
        'func DialTarget() string {',
        '  return "ok"',
        '}',
        '',
      ].join('\n'));

      const result = await searchCodebase(root, 'grpcutil', { projectRoot: root });

      expect(result.matchingSymbols).toHaveLength(0);
      expect(result.foldedFiles.map((file) => file.filePath)).toEqual(['grpcutil.go']);
      expect(formatSearchResults(result, 'grpcutil')).toContain('── Folded File Views ──');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses tree-sitter-cli 0.26 compatible --grammar-path argument order', () => {
    const source = readFileSync(join(import.meta.dir, '../../src/services/smart-file-read/parser.ts'), 'utf-8');
    expect(source).toContain('["query", "--grammar-path", grammarPath, queryFile, ...sourceFiles]');
  });

  it('parses and unfolds Go functions through tree-sitter', () => {
    const source = [
      'package grpcutil',
      '',
      'func DialTarget() string {',
      '  return "ok"',
      '}',
      '',
    ].join('\n');

    const parsed = parseFile(source, 'grpcutil.go', process.cwd());

    expect(parsed.language).toBe('go');
    expect(parsed.symbols.map((symbol) => symbol.name)).toContain('DialTarget');
    expect(unfoldSymbol(source, 'grpcutil.go', 'DialTarget', process.cwd())).toContain('func DialTarget() string');
  });
});
