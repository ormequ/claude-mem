# Claude-Mem: AI Development Instructions

Claude-mem is a Claude Code plugin providing persistent memory across sessions. It captures tool usage, compresses observations using the Claude Agent SDK, and injects relevant context into future sessions.

## Build

```bash
npm run build-and-sync        # Build, sync to marketplace, restart worker
```

## File Locations

- **Source**: `<project-root>/src/`
- **Built Plugin**: `<project-root>/plugin/`
- **Installed Plugin**: `~/.claude/plugins/marketplaces/thedotmack/`
- **Database**: `~/.claude-mem/claude-mem.db`
- **Chroma**: `~/.claude-mem/chroma/`

## Requirements

- **Bun** (all platforms - auto-installed if missing)
- **uv** (all platforms - auto-installed if missing, provides Python for Chroma)
- Node.js

## Documentation

**Public Docs**: https://docs.claude-mem.ai (Mintlify)
**Source**: `docs/public/` - MDX files, edit `docs.json` for navigation
**Deploy**: Auto-deploys from GitHub on push to main

## This repository is public

**Write docs, specs, notes and reports to `docs-local/` — never to a tracked path — unless the
owner explicitly asks for that document to be committed.** `docs-local/` is gitignored.

The default is local because a document written to help this repo tends to carry the evidence it
was derived from: production incidents, project names, machine statistics, correction rates, quotes
from private instruction files and memory, prompt ids, home paths. Individually each looks
harmless; together they are a profile of one person's work, published under their name.

Grepping for identifiers before committing is **not** sufficient — a document can contain no path,
no login and no project name and still describe a specific incident on a specific day. Judge the
content, not the markers.

**Documentation is written on the owner's machine, not into this repository.** No public
documentation is published from this fork, so there is no audience here that a doc could serve —
only exposure. Specs, plans, bug write-ups, session notes, reviews and reports all go to
`docs-local/` by default, and sanitising one is not a substitute for keeping it out: placeholders
make a work document less useful without making it belong in a public repo.

The exception is documentation **about the fork itself** — what it changes against upstream, how to
install it, how to re-sync — which is the reason a public fork exists. Even there: no home paths,
no project aliases, no exact store sizes.

When the owner does ask for something specific to be committed, keep the method and drop the
evidence: the lesson, the mechanism and the shape of the failure travel; the counts, dates,
incidents and quotes stay in `docs-local/`.

## Important

No need to edit the changelog ever, it's generated automatically.
