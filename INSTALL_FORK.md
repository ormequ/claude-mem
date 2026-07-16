# Installing this fork (agent runbook)

You are an agent installing the claude-mem fork for a human. Do not install
silently with defaults — the defaults are wrong for this fork's typical user.
Ask the three questions in step 1, then execute.

`FORK_NOTES.md` is the authority on *why* these defaults differ; this file is
the *how*. If the two disagree, FORK_NOTES wins and this file is stale — fix it.

## 0. Prerequisites

- Install from **this checkout**, never from `~/.claude/plugins/cache` or a
  patched marketplace directory. Edits there are not durable.
- Bun and uv are auto-installed by the installer if missing.

## 1. Ask the human first

Ask all three before running anything. Do not guess.

### Q1 — Skill set

`CLAUDE_MEM_SKILL_SET` = `compact` | `default` | `full`. **Unset resolves to
`default`**, which is how a picker silently ends up with 9 skills.

| Set | Skills | Pick when |
|---|---|---|
| `compact` | `knowledge-agent`, `mem-search`, `pathfinder`, `timeline-report` | codegraph-indexed repo, user has their own planning skills (superpowers etc.) |
| `default` | the 4 above + `smart-explore`, `learn-codebase`, `how-it-works`, `weekly-digests`, `standup` | no codegraph; wants the bundled reports |
| `full` | every bundled skill (18) | development on the fork itself |

`compact` is the recommended default for this fork's owner. Note what `compact`
deliberately omits and why (see FORK_NOTES "Fork defaults"): `learn-codebase`
and `smart-explore` are dead weight in a codegraph-indexed repo; `weekly-digests`
duplicates `timeline-report`; `make-plan`/`do`/`what-the` (in `full`) duplicate
superpowers.

### Q2 — Harnesses

The interactive installer already asks this (`Which IDEs do you use?`, a
required multiselect). It offers exactly these ids, each auto-detected:

`claude-code`, `opencode`, `openclaw`, `windsurf`, `codex-cli`, `cursor`,
`copilot-cli`, `antigravity`, `goose`, `roo-code`, `warp`

Confirm the human's list before answering that prompt — `[detected]` marks what
is on the machine, but detection is a hint, not their intent. Claude Code,
OpenCode, and Codex CLI share project identity by workspace alias, so the same
project memory is reused across them (FORK_NOTES "Runtime policy").

### Q3 — Disable the `smart_*` MCP tools?

Offer this explicitly. Recommend **yes** whenever the repo is codegraph-indexed
(a `.codegraph/` directory exists) — `smart_search`/`smart_outline`/
`smart_unfold` are the tree-sitter tools codegraph replaced, and the fork
dropped the tree-sitter work entirely (FORK_NOTES "Dropped: smart-file-read").
Left on, their schemas cost context on every session for nothing.

## 2. Install

### Fork owner / dev checkout (the usual path)

```bash
CLAUDE_MEM_SKILL_SET=compact npm run build-and-sync
```

Builds, rsyncs to `~/.claude/plugins/marketplaces/ormequ` plus both version
cache dirs, filters the skills directory to the chosen set, and restarts the
worker.

**Run it with the sandbox disabled.** It needs to read `node_modules` (the
sandbox deny-lists it, so `esbuild` fails to resolve) and write under
`~/.claude/plugins` (outside the write allowlist). In the sandbox it fails with
`ERR_MODULE_NOT_FOUND` for esbuild — that error is the sandbox, not a missing
dependency.

### Fresh machine / end user

```bash
CLAUDE_MEM_SKILL_SET=compact npx claude-mem install
```

Interactive. It will ask for IDEs (Q2), runtime, provider, and telemetry.
Answer: runtime **worker** (the fork's default — server beta is not ready,
FORK_NOTES "Runtime policy"), telemetry **no** (the fork defaults it off).

## 3. Apply the Q3 answer (smart tools)

If the human said yes, add to the **`env` block of `~/.claude/settings.json`**:

```json
{
  "env": {
    "CLAUDE_MEM_SMART_TOOLS": "false"
  }
}
```

This removes the three tools from MCP registration entirely (both ListTools and
CallTool) and drops `smart-explore` from the `default` skill set.

Two traps, both verified:

- **`~/.claude-mem/settings.json` does NOT work for this key.**
  `smartToolsEnabled()` reads `process.env` directly, and
  `SettingsDefaultsManager.loadFromFile` copies only keys in its `DEFAULTS`
  whitelist — which omits `CLAUDE_MEM_SMART_TOOLS`, so an entry there is
  silently dropped. The MCP server loads no settings file at all.
- **A `permissions.deny` on the tools is not equivalent.** It blocks calls but
  leaves them registered, so the schemas still cost context. Removal from
  registration is the point.

## 4. Verify — do not skip

Check the installed skills directory, not the build log. A failed `bun install`
aborts the sync **before** skill filtering and silently leaves all 18 skills.

```bash
find ~/.claude/plugins/marketplaces/ormequ/plugin/skills -maxdepth 1 -mindepth 1 -type d -exec basename {} \; | sort
```

Expect exactly the chosen set (for `compact`: `knowledge-agent`, `mem-search`,
`pathfinder`, `timeline-report`). Check the version cache dirs under
`~/.claude/plugins/cache/ormequ/claude-mem/*/skills` too — they are separate
copies.

Then tell the human to **restart Claude Code**. The skill set and the
`smart_*` removal only take effect in a new session: the running MCP server
holds the old environment.

## 5. Post-install smoke test

- `observation_add` with `projectId: "MKS"`
- `memory_search` with a fresh marker
- `query_corpus mks-smoke-test` (OpenRouter path, no Claude OAuth)
