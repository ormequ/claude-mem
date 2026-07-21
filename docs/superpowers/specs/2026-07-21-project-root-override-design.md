# Project Root Override Design

## Goal

Allow a user to set `CLAUDE_MEM_PROJECT_ROOT` so every Claude Mem project
lookup inside that directory hierarchy uses one shared project key. This lets
a directory containing several independent Git repositories share memory.

## Context

Project identity is currently derived by running `git rev-parse
--show-toplevel` for the hook cwd. In `MKS/marketplace-api`, that yields the
child repository and produces the `marketplace-api` key, even when the caller
has configured `/Users/belokobylskiiilia/Development/MKS` as its intended
shared root. No code currently reads `CLAUDE_MEM_PROJECT_ROOT`.

## Alternatives considered

1. Override project identity centrally in `getProjectContext` (chosen).
   All read and write paths already use this helper, so SessionStart context,
   session initialization, observations, file context, and transcript paths
   remain aligned.
2. Apply the override only in the SessionStart handler. This would inject MKS
   memory while subsequent writes remain tagged `marketplace-api`, causing
   future sessions to lose their own observations.
3. Query both the shared root and the child repository. This preserves
   per-repository isolation and therefore does not meet the requested single
   shared-memory model; it also makes the same configuration ambiguous.

## Design

`getProjectContext(cwd)` will first read and trim `CLAUDE_MEM_PROJECT_ROOT`.
When it is set, the configured directory is used as the project-identity
source rather than the hook cwd. It is intentionally treated as a grouping
root: its basename (or its own Git root if it is a Git repository) becomes
the only project key, and worktree expansion is skipped. When unset, the
existing cwd- and worktree-derived behavior remains byte-for-byte compatible.

For the stated configuration, every hook under `MKS` resolves to `MKS`. This
matches the 245 existing MKS sessions already in the local memory database;
the historical `marketplace-api` record remains separate rather than being
silently rewritten.

## Validation

Unit tests will prove that an unset variable keeps normal and worktree
behavior unchanged, while a set root maps a child Git repository to the
shared root key and produces `allProjects: ['MKS']`. Handler tests will prove
that SessionStart sends `projects=MKS` and session initialization writes
`project: 'MKS'`. The affected test suites and the project build will run
before publication.
