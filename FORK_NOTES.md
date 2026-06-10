# claude-mem fork cleanup notes

This fork exists to turn the local post-update patches from `~/.claude/plugins/cache/...` into normal source changes.

Local history of the manual fixes:

- `~/claude-mem-update-fix.md`

Current goal:

- Stop patching minified installed bundles after every upstream update.
- Move the downstream behavior into source files in this fork.
- Test the fork through Claude Code with `--plugin-dir` before installing it as a marketplace plugin.

Fixes to port from the local patched bundles:

1. Server-beta write payload compatibility
   - `observation_add` / `memory_add` must send `content`.
   - Keep `narrative` as a legacy alias if the upstream code still uses it.

2. Server-beta project id normalization
   - If MCP receives a UUID `projectId`, pass it through.
   - If MCP receives an alias/name like `MKS`, use `CLAUDE_MEM_SERVER_BETA_PROJECT_ID` from settings.
   - This avoids `403 API key scoped to a different project`.

3. Tree-sitter CLI compatibility
   - `tree-sitter-cli@0.26.x` expects:

     `tree-sitter query --grammar-path <grammarPath> <queryPath> <files...>`

   - The installed bundle used an incompatible argument order after updates.
   - Also make sure the native `tree-sitter` binary is installed or copied during build/install.

4. `smart_search` fallback behavior
   - If AST parsing finds symbols but the query only matches file path or file content, return a folded file view instead of "0 results".
   - This matters for package/directory queries such as `grpcutil`.

5. `query_corpus` OpenRouter mode
   - Current upstream corpus agent uses Claude Code SDK / Claude Desktop OAuth for `query_corpus`.
   - In `CLAUDE_MEM_PROVIDER=openrouter` mode, route corpus queries to the OpenRouter-compatible `/chat/completions` endpoint instead.
   - For this local setup the endpoint is `https://ai.selectel.org/api/chat/completions`.
   - This is stateless: each query sends the corpus context again and does not use Claude SDK session resume.

6. Worker launch behavior
   - On 13.5.4, `worker-service.cjs --daemon` briefly answered `/api/version` and then exited.
   - Stable local launch used foreground server mode under `nohup`:

     `nohup /opt/homebrew/bin/bun path/to/worker-service.cjs >/tmp/claude-mem-worker.log 2>&1 &`

Useful verification commands:

```bash
claude plugin validate
claude --plugin-dir ~/Development/tools/claude-mem
```

Smoke checks after porting source changes:

- `observation_add` with `projectId: "MKS"` writes successfully.
- `memory_search` finds that marker.
- `smart_outline` parses a Go file.
- `smart_search grpcutil` returns non-zero matches.
- `query_corpus mks-smoke-test` works without Claude Desktop OAuth.

Do not keep editing generated/minified files in `~/.claude/plugins/cache/...` except as a temporary debugging aid. The durable fix belongs in this fork's source files.


## Current local setup

This machine currently runs a mixed setup: server-beta for the newer REST/MCP memory operations, plus the legacy worker for older routes that are still used by some tools.

Important local paths:

- Fork/source checkout: `~/Development/tools/claude-mem`
- Main settings: `~/.claude-mem/settings.json`
- Manual patch history: `~/claude-mem-update-fix.md`
- Server-beta infra compose: `~/.claude-mem/server-beta-infra/docker-compose.yml`

Docker compose is only for local infrastructure, not for running the claude-mem app/plugin itself.

Current compose services:

- Postgres: `127.0.0.1:37543`
- Valkey/Redis: `127.0.0.1:37637`

Runtime endpoints:

- Server-beta HTTP/API/dashboard: `http://127.0.0.1:37877`
- Legacy worker HTTP/API: `http://127.0.0.1:37701`

Current provider settings:

- `CLAUDE_MEM_RUNTIME=server-beta`
- `CLAUDE_MEM_PROVIDER=openrouter`
- `CLAUDE_MEM_OPENROUTER_BASE_URL=https://ai.selectel.org/api`
- `CLAUDE_MEM_OPENROUTER_MODEL=minimax-m2.7`

Why both server-beta and worker still exist:

- New write/search/context MCP tools use server-beta `/v1/...` routes.
- Corpus tools such as `build_corpus`, `prime_corpus`, and `query_corpus` still proxy to the legacy worker `/api/corpus/...` routes.
- The local patch makes `query_corpus` use OpenRouter in worker mode so it does not depend on Claude Desktop OAuth.

Do not assume Docker Compose runs the full app. It only provides database/cache infrastructure for server-beta. The plugin/MCP/worker processes are still launched by Claude Code or manually during debugging.


## Fork branch status: local fixes port

Branch: `fork-local-fixes`

Source-level fixes now live in the fork instead of `~/.claude/plugins/cache` patches:

- MCP server-beta writes normalize non-UUID `projectId` aliases to `CLAUDE_MEM_SERVER_BETA_PROJECT_ID`; UUID values still pass through.
- `observation_add` / `memory_add` write payloads include `content` and keep `narrative` as a legacy alias.
- Smart file parsing calls `tree-sitter query --grammar-path <grammarPath> <queryPath> <files...>` for `tree-sitter-cli@0.26.x`.
- `smart_search` keeps folded file views for path/content matches even when symbol names do not match.
- `query_corpus` in `CLAUDE_MEM_PROVIDER=openrouter` mode uses an OpenAI-compatible `/chat/completions` request and avoids Claude Code SDK/OAuth.
- Worker daemon spawning detaches Bun while running `worker-service.cjs` in foreground server mode, matching the stable `nohup bun worker-service.cjs` launch shape.

Validation completed locally:

```bash
bun install
bun test tests/servers/mcp-server-beta-fork-fixes.test.ts \
  tests/services/smart-file-read-fork-fixes.test.ts \
  tests/worker/knowledge-agent-openrouter-corpus.test.ts \
  tests/infrastructure/worker-daemon-foreground-spawn.test.ts \
  tests/servers/mcp-tool-schemas.test.ts \
  tests/services/worker-spawner.test.ts \
  tests/services/worker-daemon-port-race.test.ts
bun run typecheck:root
npm run build
claude plugin validate .
```

Known remaining gaps:

- `--plugin-dir` is only a local test override. The durable Claude Code setup
  should install this fork as its own marketplace:

  ```bash
  claude plugin marketplace add ormequ/claude-mem#fork-local-fixes
  claude plugin uninstall claude-mem
  claude plugin install claude-mem@ormequ
  claude plugin list
  ```

- Before switching plugin sources, a Postgres custom-format backup was written
  under `dumps/` and `dumps/` is gitignored so database backups do not enter
  commits.
- End-to-end MCP smoke still needs to be rerun against the live local services:
  - `observation_add` with `projectId: "MKS"`
  - `memory_search` for the marker
  - `smart_outline` on a Go file
  - `smart_search grpcutil`
  - `query_corpus mks-smoke-test` without Claude OAuth
- `gh auth status` reports the stored GitHub CLI token for `ormequ` is invalid. SSH push may still work, but opening a PR with `gh` requires `gh auth login -h github.com` or using the GitHub app connector.
