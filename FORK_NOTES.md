# claude-mem fork notes

This fork keeps local claude-mem fixes in source control instead of patching
`~/.claude/plugins/cache` or installed marketplace files by hand.

Installing it? Follow `INSTALL_FORK.md` — an agent runbook that asks the human
for the skill set, the harnesses, and whether to drop the `smart_*` MCP tools
before touching anything. Installing with defaults is how the picker silently
ends up on `default`. These notes stay the authority on *why* those defaults
differ; INSTALL_FORK.md is the *how*.

The notes themselves live in `fork-notes/`, one file per area. This file is the
index — keep it that way, and add new material to the area file it belongs to.

## Runtime policy

- Worker runtime remains the default runtime for this fork.
- Server beta fixes are kept in source, but server beta is not the default
  runtime until its project separation and event viewer behavior are fully
  aligned with worker runtime.
- Claude Code, OpenCode, and future harnesses should share project identity by
  workspace/project alias rather than by harness name.

## Index

| File | What is in it |
|---|---|
| [`fork-notes/install-defaults.md`](fork-notes/install-defaults.md) | Telemetry off by default; the three skill sets (`default`/`compact`/`full`) and what each drops; `CLAUDE_MEM_INSTALL_EXTRA_SKILLS`; the env-only `CLAUDE_MEM_SMART_TOOLS` gate. |
| [`fork-notes/cross-harness-reads.md`](fork-notes/cross-harness-reads.md) | All project-level memory reads ignore `platform_source` (reverts upstream `348d9ee4` on the read path), layer by layer, with the re-sync steps and guard tests. |
| [`fork-notes/read-hook.md`](fork-notes/read-hook.md) | `PreToolUse:Read` file-context deltas: adopt-pointer scoping, `⚠ may be stale` by git content time, the ranking replay gate, the trimmed header — plus the upstream allow/deny baseline and why deny is settled-rejected. |
| [`fork-notes/adoption.md`](fork-notes/adoption.md) | Hourly merged-worktree adoption, the known-cwd registry that fixed its silent no-op, `adopt-mem --orphans` for deleted worktrees, and the sync-lane Chroma flag. |
| [`fork-notes/chroma.md`](fork-notes/chroma.md) | Corruption recovery runbook, and the SQLite-flag merge-patch drain that replaced inline Chroma writes. |
| [`fork-notes/observations.md`](fork-notes/observations.md) | Concept vocabulary enforced at parse time, `code.json` type/concept guidance, the `change` type fallback, `prompt_version`, `agent_type` canonicalization, empty-concept injection gate, the English-only rule. |
| [`fork-notes/prompts-and-harness-review.md`](fork-notes/prompts-and-harness-review.md) | The `harness-review` skill and its lanes; `get_prompts` / `/api/prompts/batch`; the `getUserPromptsByIds` LEFT JOIN; machine relays filtered out of prompt reads. |
| [`fork-notes/provider-rate-limits.md`](fork-notes/provider-rate-limits.md) | The rolling request ceiling on the OpenAI-compatible path: the shared `CallPacer`, the rate-limit wait in `retry.ts`, and the four `CLAUDE_MEM_OPENROUTER_*` settings with the numbers behind their defaults. |
| [`fork-notes/misc-deltas.md`](fork-notes/misc-deltas.md) | `CLAUDE.local.md` maintainer directives, MCP ListTools gate composition, server-beta `content`, `projectId` aliases, OpenRouter QA model, worker launch, OpenCode install, `prime_corpus` cold start, adopt-pointer search. |
| [`fork-notes/branch-layout.md`](fork-notes/branch-layout.md) | `main` is the fork, `upstream` is the mirror; the marketplace-pin trap, how to detect it and how to sync the mirror server-side. |
| [`fork-notes/dropped-tree-sitter.md`](fork-notes/dropped-tree-sitter.md) | Abandoned smart-file-read / tree-sitter work and why the plugin manifest no longer ships the grammars. Do not re-add. |
| [`fork-notes/upgrade-checklist.md`](fork-notes/upgrade-checklist.md) | What to run after rebasing or merging upstream, including the cross-harness guard tests and the pin verification. |
