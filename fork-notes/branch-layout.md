# Branch layout and the marketplace-pin trap (2026-07-30)

**`main` is the working branch and the repo's default, and now the only branch.
There is no `upstream` mirror branch any more** — see the standalone-repo note
below for why, and for what replaced it.

Renamed 2026-08-15 (`main` → `upstream`, `fork-fixes` → `main`) precisely to
defuse the trap below: Claude Code installs `claude-mem@ormequ` from the
marketplace repo's DEFAULT branch and pins
`~/.claude/plugins/installed_plugins.json` to the cache dir it created. While
the default branch was the upstream mirror, the moment `ormequ/main` was
fast-forwarded to upstream the next plugin refresh installed **plain upstream**
into `~/.claude/plugins/cache/ormequ/claude-mem/<upstream-version>/` and repinned
to it — silently replacing the fork with upstream code and re-widening the skill
picker to all 18. Measured 2026-07-30: syncing `main` to v13.12.4 repinned the
install to `cache/ormequ/claude-mem/13.12.4` at `gitCommitSha 132b4634`
(upstream's tip) while `build-and-sync` kept updating the fork's own
`13.12.4-fork.worker.*` dir, which nothing then loaded. The default branch now
carries the fork, so a mirror sync can no longer do this — but everything below
still applies to any pin that is already wrong.

**`origin` is no longer a GitHub fork (2026-08-15).** The repo was rebuilt as a
standalone one-commit repository to drop a published history that carried one
person's identifying detail. Two consequences, both permanent:

- **No shared object storage with the parent**, so the old server-side mirror
  sync (`gh api -X PATCH …/refs/heads/upstream -f sha=$SHA`, which cost no
  download precisely because a fork shares the parent's objects) no longer
  works. Upstream now arrives only over the wire.
- **The first `git fetch upstream` pulls the parent's whole history** — measured
  2026-08-15 at ~24.6k objects, which can crawl for an hour. Budget for it once;
  after that the remote is incremental like any other.

**The squash also cut the shared ancestry, so an upstream merge has no base to
compute from.** `main` is a single root commit; `git merge upstream/main` would
refuse outright, and `--allow-unrelated-histories` would treat every file as a
conflict. Merge from the recorded base instead — the upstream commit this tree
was last merged with:

```
fork base: 93ca2a86  ("fix(dedup): veto a near-dup token sitting at exactly idfVetoDf records", upstream v13.35.0 + 2)
git fetch upstream main --no-tags --filter=blob:none
git diff 93ca2a86..upstream/main | git apply -3      # 3-way: conflicts only where both moved
```

**Update the recorded base to the new upstream tip every time upstream is
adopted** — it is the only thing standing in for the missing merge base, and a
stale one silently re-applies changes that are already in.

The clone is partial (`--filter=blob:none`): commits and trees are local, file
contents are fetched on demand, so the first diff against an old revision pauses
to download blobs and nothing works offline. A plain `git fetch upstream` fills
the history in completely if that ever becomes annoying.

There is no local mirror branch to keep any more — the mirror existed to make
"Sync fork" and the server-side PATCH usable, and both are gone. The `upstream` remote
(`git@github.com:thedotmack/claude-mem.git`) is push-disabled on purpose
(`git remote set-url --push upstream DISABLED_no_push`); keep it that way.

Nothing about the install path changed: the `ormequ` marketplace is registered
as a **directory** (`~/.claude/plugins/marketplaces/ormequ`), not a GitHub repo,
so `build-and-sync` is still what updates the plugin and no rename or repo swap
can move it.

Two aggravating details:

- `sync-marketplace.cjs` (rsync replaced by upstream's `mirrorDirectory` in
  v13.35.0; the fork's dir set is unchanged) only mirrors into the build's own cache dir, the raw
  `+` variant, and the *running worker's* dir (`getActiveCacheVersion`). A dir
  Claude Code pinned on its own is not in that set, so a normal
  `build-and-sync` does not repair the situation and reports success.
- Upstream's version ranking (v13.12, restart-storm fix) sorts a RELEASE ahead
  of a prerelease at the same base, and the fork's cache dir name
  `13.12.4-fork.worker.<date>.1` parses as a prerelease of `13.12.4`. So a plain
  `13.12.4` dir also outranks the fork dir in every worker/MCP resolver.

Since 2026-08-06 `sync-marketplace.cjs` also mirrors into the dir named by
`installed_plugins.json` (`getPinnedCacheVersion`). That closes the gap
`getActiveCacheVersion` cannot: it keys off a *version mismatch*, so a pinned dir
that was hand-repaired once reports the fork version while its code and skill set
silently rot (measured 2026-08-06: the pinned `13.12.4` dir carried a 30 Jul mirror
and 4 skills, missing `harness-review`). Verify the pin anyway — a dir the script
mirrors into is not the same as the dir Claude Code loads next refresh.

Same commit: the marketplace-root `bun install` runs with `--ignore-scripts`.
It resolves the repo's tree-sitter dev deps, whose install script downloads from
the GitHub release CDN (blocked here) — and a failed install aborts the sync
**before** `filterSkills`, so the run reports failure but leaves all 18 skills
in place.

Detect it (the check is on the PIN, not on the build log):

```bash
python3 -c "import json;d=json.load(open('$HOME/.claude/plugins/installed_plugins.json'));print(d['plugins']['claude-mem@ormequ'])"
grep -m1 '\"version\"' "$(python3 -c "import json;print(json.load(open('$HOME/.claude/plugins/installed_plugins.json'))['plugins']['claude-mem@ormequ'][0]['installPath'])")/.claude-plugin/plugin.json"
```

The version there must carry `+fork.worker.`. If it does not, the running plugin
is upstream. Repair by mirroring `plugin/` into the pinned dir, re-running
`bun install` there, and re-filtering skills to the chosen set — then restart
the worker.

## Fork version scheme

`<upstream version>+fork.worker.<YYYYMMDD>.<n>`, set by hand in `package.json`,
`plugin/package.json` (or regenerate it with the build), `.claude-plugin/`
`marketplace.json` + `plugin.json`, `plugin/.claude-plugin/plugin.json`, both
`.codex-plugin/plugin.json` files, and the two `.cursor-plugin/plugin.json`
manifests (`claude-mem-cursor`, `claude-mem-grok-bot`) that
`tests/infrastructure/version-consistency.test.ts` checks. Other harness manifests
(openclaw, dsh, `.grok-plugin`) keep upstream's version. Upstream's own
marketplace name appears in new upstream code on every merge
(`claude-mem@thedotmack`, `cache/thedotmack`): grep for it and rename where it
addresses this install — `prune-cache.ts` keyed its protected version off it,
which would have pruned the pinned fork dir.
