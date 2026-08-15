# Dropped: smart-file-read / tree-sitter fork work (2026-07-14)

The fork no longer carries any smart-file-read delta. `codegraph` replaced
tree-sitter for code structure, so these fixes were abandoned rather than
re-applied:

- the `tree-sitter-cli@0.26.x` `--grammar-path` query shape,
- resilient binary resolution (0-byte placeholder ignored, PATH/homebrew/cargo
  preferred over the release CDN),
- Vue/Svelte SFC `<script>` parsing,
- `smart_search` folded file views — this one is upstream behavior now.

State as of the v13.11.0 merge: `src/services/smart-file-read/parser.ts` and
`search.ts` are byte-identical to `origin/upstream`. The fork test that covered the
items above (`tests/services/smart-file-read-fork-fixes.test.ts`) was deleted — it had
been failing at import (`ensureTreeSitterCliBinary` no longer exists), and all
its remaining cases failed too because tree-sitter parsing returns no symbols
here.

**The generated `plugin/package.json` no longer ships tree-sitter** (fork delta in
`scripts/build-hooks.js`, which generates that manifest — editing
`plugin/package.json` directly is pointless, the build overwrites it). Dropped
`tree-sitter-cli`, all 25 grammars, the `tree-sitter` `overrides` entry, and
`trustedDependencies`. Rationale: `tree-sitter-cli` was the *only* trusted
dependency — the only one Bun runs an install script for — and that script
downloads a binary from the GitHub release CDN, which this network blocks. Every
`bun install` in the plugin folder therefore failed, and a failed sync aborts
**before** `sync-marketplace.cjs` filters skills, silently widening the skill
picker back to all 18. The grammars are ~495 MB of dead weight without the CLI.
Plugin deps are now just `zod` + `shell-quote` (2 installs / 3 packages).

Note the repo-root `package.json` still carries the tree-sitter dev deps, and
`sync-marketplace.cjs` rsyncs the whole repo, so `bun install` at the
*marketplace root* still resolves them — use `bun install --ignore-scripts` there
if node_modules ever needs rebuilding.

Do not re-add these on the next upstream merge. Use `codegraph explore` for
structure. The `PreToolUse:Read` header no longer hints at any structure tool
(it briefly pointed at `codegraph` in `a1e7180f`); `CLAUDE_MEM_SMART_TOOLS=false`
removes the `smart_*` tools from MCP registration entirely.
