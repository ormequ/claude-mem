import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureTreeSitterCliBinary, parseFile, unfoldSymbol } from '../../src/services/smart-file-read/parser.js';
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

  it('repairs a tree-sitter-cli install where --ignore-scripts skipped the binary download', () => {
    const packageDir = mkdtempSync(join(tmpdir(), 'cmem-tree-sitter-cli-'));
    try {
      writeFileSync(join(packageDir, 'install.js'), [
        'const { writeFileSync, chmodSync } = require("node:fs");',
        'const { join } = require("node:path");',
        'const target = join(process.cwd(), process.platform === "win32" ? "tree-sitter.exe" : "tree-sitter");',
        'writeFileSync(target, "#!/usr/bin/env node\\n");',
        'chmodSync(target, 0o755);',
      ].join('\n'));

      const binPath = ensureTreeSitterCliBinary(packageDir);

      expect(binPath).toBe(join(packageDir, process.platform === 'win32' ? 'tree-sitter.exe' : 'tree-sitter'));
      expect(existsSync(binPath!)).toBe(true);
    } finally {
      rmSync(packageDir, { recursive: true, force: true });
    }
  });

  it('treats a 0-byte placeholder binary as missing (no usable PATH/install fallback)', () => {
    const packageDir = mkdtempSync(join(tmpdir(), 'cmem-tree-sitter-empty-'));
    try {
      // Simulate the placeholder left when the postinstall download is skipped/blocked.
      writeFileSync(join(packageDir, process.platform === 'win32' ? 'tree-sitter.exe' : 'tree-sitter'), '');
      // No install.js to repair it, so the empty placeholder must not be returned.
      expect(ensureTreeSitterCliBinary(packageDir)).toBeNull();
    } finally {
      rmSync(packageDir, { recursive: true, force: true });
    }
  });

  it('parses PHP classes, methods, and functions through tree-sitter', () => {
    const source = [
      '<?php',
      'namespace App\\Services;',
      'class UserService {',
      '  public function findUser(int $id): ?User { return null; }',
      '}',
      'function helper_fn(string $x): string { return $x; }',
      '',
    ].join('\n');

    const parsed = parseFile(source, 'UserService.php', process.cwd());

    expect(parsed.language).toBe('php');
    const names = parsed.symbols.flatMap((s) => [s.name, ...(s.children ?? []).map((c) => c.name)]);
    expect(names).toContain('UserService');
    expect(names).toContain('findUser');
    expect(names).toContain('helper_fn');
  });

  it('parses a Vue SFC <script setup> block as its script language', () => {
    const source = [
      '<script setup lang="ts">',
      "import { ref } from 'vue'",
      'const count = ref(0)',
      'function increment() { count.value++ }',
      '</script>',
      '<template><button @click="increment">{{ count }}</button></template>',
      '',
    ].join('\n');

    const parsed = parseFile(source, 'Counter.vue', process.cwd());

    expect(parsed.language).toBe('vue');
    expect(parsed.symbols.map((s) => s.name)).toContain('increment');
    // line numbers stay aligned to the original SFC: increment is on the 4th
    // line (0-indexed 3), proving the blanked markup preserved positions.
    const increment = parsed.symbols.find((s) => s.name === 'increment');
    expect(increment?.lineStart).toBe(3);
    expect(parsed.imports.join('\n')).toContain("from 'vue'");
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
