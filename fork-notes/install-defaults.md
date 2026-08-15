# Fork defaults: telemetry, skill sets, smart tools

Chosen defaults that differ from upstream, and the env vars that change them.
`INSTALL_FORK.md` is the runbook that applies these; this file says why.

## Fork defaults

- Telemetry is off by default.
  - `CLAUDE_MEM_TELEMETRY=1` enables anonymous telemetry.
  - `CLAUDE_MEM_TELEMETRY=0` and `DO_NOT_TRACK=1` keep it off.
  - The installer prompt defaults to no.
- The installed skill set has three modes, chosen via `CLAUDE_MEM_SKILL_SET`
  (`default` | `compact` | `full`; unset → `default`). Extra bundled skills stay
  available in source for development but are removed from the installed skills
  directory unless the mode keeps them.
  - `default` — core + reports, plus `knowledge-agent`:
    - `mem-search`, `smart-explore`, `learn-codebase`, `how-it-works`,
      `timeline-report`, `weekly-digests`, `standup`, `pathfinder`,
      `knowledge-agent`
  - `compact` — memory core + the situational tools worth a permanent slot:
    `knowledge-agent`, `mem-search`, `pathfinder`, `timeline-report`,
    `harness-review`. The last one is periodic rather than a permanent slot and
    would normally not survive the trim, but it owns the fix ledger and the run
    series (`~/.claude-mem/state/harness-ledger.md`,
    `harness-review-series.md`) — dropping it from the smallest set means the one
    loop that measures whether the harness improves is the first thing cut.
    `learn-codebase` was dropped (2026-07-16): it brute-reads every file to
    front-load context, which `codegraph` (queried on demand) makes dead weight
    in an indexed repo. `pathfinder` (architecture audit before a refactor) took
    its slot — not "memory", but a heavy tool actually reached for.
    `timeline-report` is the one narrative report kept; `weekly-digests` reads
    the same whole-history data as serial per-week chapters ("If the user wants
    a single sweeping report, use timeline-report instead" — its own SKILL.md),
    so shipping both duplicates one source in two formats.
  - `full` — every bundled skill (no filtering)
- `CLAUDE_MEM_INSTALL_EXTRA_SKILLS` extends the `default` or `compact` set
  with comma-separated bundled skill directory names; for example,
  `CLAUDE_MEM_SKILL_SET=compact CLAUDE_MEM_INSTALL_EXTRA_SKILLS=babysit,weekly-digests`.
  Names are trimmed and deduplicated. Unknown names abort the install and list
  the available bundled skills. `full` validates configured names but retains
  every bundled skill.
- Legacy `CLAUDE_MEM_INSTALL_ALL_SKILLS=true` still maps to `full`;
  `CLAUDE_MEM_SKILL_SET` takes precedence when both are set.
- `knowledge-agent` is included by default because the fork enhances its corpus
  Q&A path (`CLAUDE_MEM_OPENROUTER_QA_MODEL`, see `misc-deltas.md`).

## The `smart_*` MCP tool gate

- `CLAUDE_MEM_SMART_TOOLS=false|0` removes `smart_search`/`smart_unfold`/
  `smart_outline` from MCP registration (both ListTools and CallTool) and drops
  `smart-explore` from the default skill set. Default: enabled (upstream
  parity). `compact` never shipped smart-explore; `full` stays unfiltered by
  contract.
  **It is env-only — `~/.claude-mem/settings.json` does NOT work for it.** Two
  independent reasons: `smartToolsEnabled()` reads `process.env` directly and
  never consults settings, and `SettingsDefaultsManager.loadFromFile` copies
  only keys present in its `DEFAULTS` whitelist, which does not carry
  `CLAUDE_MEM_SMART_TOOLS` — an entry there is silently dropped. The MCP server
  loads no settings file at all, so env is its only channel. Set it in the
  `env` block of `~/.claude/settings.json`; `plugin/.mcp.json` spawns the
  server with `stdio: 'inherit'`, so Claude Code's env propagates. This is a
  deliberate inconsistency with every other setting (which is settings.json-
  driven): routing it through `SettingsDefaultsManager` would put a fork delta
  in an upstream file and buy merge cost, while `smart-tools.ts` is fork-owned.
  Note a `permissions.deny` on the `smart_*` tools is **not** equivalent — it
  blocks calls but leaves the tools registered, so their schemas still cost
  context. Removal from registration is the point.
  **Any test asserting the `default` skill set must `delete
  process.env.CLAUDE_MEM_SMART_TOOLS` in `beforeEach` and restore it after.**
  A dev box that sets the gate in `~/.claude/settings.json` has it propagated
  into the test env by Claude Code, so `smart-explore` is absent from the
  default set and the assertion fails locally while passing in CI — a
  developer-only red that reads as a real break. Bit
  `skill-selection.test.ts` first and `opencode-installer.test.ts` again on
  2026-07-17.
