# Extra Skill Installation Design

## Goal

Allow an installer caller to extend the selected Claude-Mem skill preset with
specific bundled skills through `CLAUDE_MEM_INSTALL_EXTRA_SKILLS`, while
keeping the existing `default`, `compact`, and `full` presets unchanged.

## Configuration

- `CLAUDE_MEM_SKILL_SET` continues to choose `default`, `compact`, or `full`.
- `CLAUDE_MEM_INSTALL_EXTRA_SKILLS` is an optional comma-separated list of
  bundled skill directory names. Whitespace is trimmed, empty entries are
  ignored, and duplicate names are installed once.
- Extras are unioned with the selected preset. For example,
  `CLAUDE_MEM_SKILL_SET=compact` and
  `CLAUDE_MEM_INSTALL_EXTRA_SKILLS=babysit,weekly-digests` installs the three
  compact skills plus `babysit` and `weekly-digests`.
- `full` still keeps every bundled skill. Extra names are nevertheless
  validated so an invalid configuration cannot silently pass.

## Validation and Error Handling

The skill-selection layer discovers the bundled skill directories before it
removes any of them. Every configured extra must match one of those directory
names exactly. If one or more names are unknown, it throws a clear error that
identifies the invalid names and lists the available bundled skills. The target
skills directory is left unmodified by the filtering operation in this case.

This intentionally makes a typo such as `babisit` fail rather than silently
omitting the requested `babysit` skill.

## Installation Paths

The final allowlist is calculated by `SkillSelection` and used consistently by:

- Claude Code marketplace copying;
- Claude Code plugin-cache copying; and
- OpenCode skill copying.

No new machine-wide environment variable will be written for the fork owner.
Their local refresh uses `CLAUDE_MEM_SKILL_SET=compact` with
`CLAUDE_MEM_INSTALL_EXTRA_SKILLS` unset, so only the compact preset is
installed.

## Testing

Extend the skill-selection tests to prove that compact-plus-extras produces a
deduplicated union, that whitespace and empty entries are harmless, and that
unknown extras throw before any skill directory is removed. Extend the OpenCode
installer test coverage as needed to show it copies the same final selection.
Run the focused skill-selection and installer tests, then the fork upgrade
checks from `FORK_NOTES.md` before syncing the local plugin installation.
