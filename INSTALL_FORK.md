# Installing this fork (agent runbook)

You are an agent installing the claude-mem fork for a human. Do not install
silently with defaults — the defaults are wrong for this fork's typical user.
Ask the four questions in step 1, then execute.

`FORK_NOTES.md` is the authority on *why* these defaults differ; this file is
the *how*. If the two disagree, FORK_NOTES wins and this file is stale — fix it.

## 0. Prerequisites

- Install from **this checkout**, never from `~/.claude/plugins/cache` or a
  patched marketplace directory. Edits there are not durable.
- Bun and uv are auto-installed by the installer if missing.

## 1. Ask the human first

Ask all four before running anything. Do not guess.

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

### Q4 — Which model provider?

The interactive installer asks this too (`Which memory provider do you want to
use?`): `claude` (default) | `gemini` | `openrouter`. This picks what compresses
every tool call into an observation, so it is a cost decision, not a taste one —
it runs constantly in the background.

Ask which the human wants, and whether they want a stronger model for
knowledge-agent answers than for bulk compression (fork-only, OpenRouter path).
Section 4 has the full option table and the keys.

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

## 4. Models — options and configuration

**Where these live: `~/.claude-mem/settings.json`, as flat top-level keys** (a
nested `env` object is auto-migrated to flat on load). Unlike
`CLAUDE_MEM_SMART_TOOLS` (section 3), every key below *is* in
`SettingsDefaultsManager`'s `DEFAULTS` whitelist, so settings.json works for
them. A real env var still overrides settings.json (`applyEnvOverrides`).

### Provider

`CLAUDE_MEM_PROVIDER` = `claude` (default) | `gemini` | `openrouter`

| Provider | Keys | Notes |
|---|---|---|
| `claude` | `CLAUDE_MEM_MODEL` (default `claude-haiku-4-5-20251001`), `CLAUDE_MEM_CLAUDE_AUTH_METHOD` = `subscription` (default) \| `api-key` | `subscription` uses the logged-in Claude SDK account — no key needed |
| `gemini` | `CLAUDE_MEM_GEMINI_API_KEY`, `CLAUDE_MEM_GEMINI_MODEL` (default `gemini-2.5-flash-lite`), `CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED` (default `true`) | rate limiting defaults on for the free tier — leave it on unless paid |
| `openrouter` | `CLAUDE_MEM_OPENROUTER_API_KEY`, `CLAUDE_MEM_OPENROUTER_MODEL` (default `xiaomi/mimo-v2-flash:free`), `CLAUDE_MEM_OPENROUTER_QA_MODEL`, `CLAUDE_MEM_OPENROUTER_BASE_URL` | the fork's `query_corpus` uses a plain `/chat/completions` request here, so corpus Q&A works with **no Claude OAuth at all** |

### `$TIER` aliases — the portable way to name a model

Instead of a concrete id, any model key may hold `$TIER:fast`, `$TIER:smart`,
`$TIER:simple`, or `$TIER:summary`. Each resolves through a tier table:

| Alias | Key | Default |
|---|---|---|
| `$TIER:fast` | `CLAUDE_MEM_TIER_FAST_MODEL` | `haiku` |
| `$TIER:smart` | `CLAUDE_MEM_TIER_SMART_MODEL` | `sonnet` |
| `$TIER:simple` | `CLAUDE_MEM_TIER_SIMPLE_MODEL` | `haiku` |
| `$TIER:summary` | `CLAUDE_MEM_TIER_SUMMARY_MODEL` | empty → falls back to `CLAUDE_MEM_MODEL` |

Two properties worth knowing (`src/services/worker/model-aliases.ts`):

- **Resolution happens at request time, not settings-load time** — the human can
  retune models by editing settings.json with **no worker restart**.
- Anything that is not a `$TIER:*` string passes through untouched, so concrete
  ids and aliases mix freely.

`CLAUDE_MEM_TIER_ROUTING_ENABLED` (default `true`) additionally routes
observations to models by complexity.

### Fork-only: a stronger model for knowledge-agent answers

`CLAUDE_MEM_OPENROUTER_QA_MODEL` splits corpus Q&A off the bulk model. Bulk
observation/summary generation runs constantly and belongs on something cheap;
corpus *answers* are rare and are exactly where a weak model hallucinates. So:

```jsonc
// ~/.claude-mem/settings.json
{
  "CLAUDE_MEM_PROVIDER": "openrouter",
  "CLAUDE_MEM_OPENROUTER_API_KEY": "sk-or-…",
  "CLAUDE_MEM_OPENROUTER_MODEL": "xiaomi/mimo-v2-flash:free",  // bulk — cheap
  "CLAUDE_MEM_OPENROUTER_QA_MODEL": "$TIER:smart"              // answers — strong
}
```

Resolution order (`resolveOpenRouterQaModel`): QA key → `$TIER` resolution →
falls back to `CLAUDE_MEM_OPENROUTER_MODEL` → then the free-tier default. Empty
is safe: it just reuses the bulk model (upstream behavior).

### Custom OpenAI-compatible endpoints

`CLAUDE_MEM_OPENROUTER_BASE_URL` accepts any OpenAI-compatible base URL —
DeepSeek (`https://api.deepseek.com`), a local server
(`http://localhost:1234/v1`), a gateway. Empty means real OpenRouter.
`CLAUDE_MEM_OPENROUTER_SITE_URL` / `CLAUDE_MEM_OPENROUTER_APP_NAME` are
OpenRouter analytics only.

⚠ Not every "OpenAI-compatible" endpoint really is. The Z.AI coding endpoint
**silently ignores `response_format: json_schema`** — it returns 200 with
unconstrained text rather than erroring, so constrained decoding is simply not
available there (this is why the fork filters concepts at the parser instead;
FORK_NOTES, `src/sdk/parser.ts`). Expect to verify, not assume, on a new
endpoint.

## 5. Verify — do not skip

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

## 6. Post-install smoke test

- `observation_add` with `projectId: "MKS"`
- `memory_search` with a fresh marker
- `query_corpus mks-smoke-test` (OpenRouter path, no Claude OAuth)
