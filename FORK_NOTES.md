# claude-mem fork notes

This fork keeps local claude-mem fixes in source control instead of patching
`~/.claude/plugins/cache` or installed marketplace files by hand.

## Runtime policy

- Worker runtime remains the default runtime for this fork.
- Server beta fixes are kept in source, but server beta is not the default
  runtime until its project separation and event viewer behavior are fully
  aligned with worker runtime.
- Claude Code, OpenCode, and future harnesses should share project identity by
  workspace/project alias rather than by harness name.

## Fork defaults

- Telemetry is off by default.
  - `CLAUDE_MEM_TELEMETRY=1` enables anonymous telemetry.
  - `CLAUDE_MEM_TELEMETRY=0` and `DO_NOT_TRACK=1` keep it off.
  - The installer prompt defaults to no.
- The default installed skill set is intentionally compact:
  - `mem-search`
  - `smart-explore`
  - `learn-codebase`
  - `how-it-works`
  - `timeline-report`
  - `weekly-digests`
  - `standup`
  - `pathfinder`
- Extra bundled skills stay available for development, but are not installed by
  default. Set `CLAUDE_MEM_INSTALL_ALL_SKILLS=true` during install to keep every
  bundled skill.

## Local fixes carried by the fork

- `server-beta` `observation_add` / `memory_add` sends `content` while keeping
  `narrative` as a legacy alias.
- MCP `projectId` handling accepts useful aliases such as `MKS` and ignores raw
  UUID project IDs instead of using them as project aliases.
- Smart file tools use the `tree-sitter-cli@0.26.x` query shape:
  `tree-sitter query --grammar-path <grammarPath> <queryPath> <files...>`.
- `smart_search` returns folded file views for file path/content matches even
  when no symbol name matched.
- `query_corpus` uses an OpenRouter-compatible `/chat/completions` request when
  `CLAUDE_MEM_PROVIDER=openrouter`, avoiding Claude Code SDK/OAuth.
- Worker launch behavior is fixed so normal installs start the worker instead
  of relying on a brittle `--daemon` path.
- OpenCode install registers the plugin, injects shared memory context, and uses
  the same project memory as Claude Code for the same workspace.
- `prime_corpus` cold-start behavior returns a queued/try-again-later response
  instead of failing the tool call on a worker timeout.

## Upgrade checklist

After rebasing or merging upstream:

1. Rebuild generated bundles with `bun run build`.
2. Run `bun run typecheck`.
3. Run the fork-focused tests:
   `bun test tests/telemetry/consent.test.ts tests/integration/skill-selection.test.ts tests/integration/opencode-installer.test.ts tests/install-non-tty.test.ts`.
4. Run `claude plugin validate .`.
5. Install from this checkout, not from a patched cache directory.
6. Smoke test:
   - `observation_add` with `projectId: "MKS"`
   - `memory_search` with a fresh marker
   - `smart_outline` on a Go file
   - `smart_search grpcutil`
   - `query_corpus mks-smoke-test` with OpenRouter and no Claude OAuth

Do not treat edits under `~/.claude/plugins/cache` as durable fixes. Port them
back to source and rebuild/reinstall the fork.
