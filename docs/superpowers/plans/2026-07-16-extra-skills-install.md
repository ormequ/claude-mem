# Extra Skill Installation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let callers extend a selected Claude-Mem skill preset with validated bundled skills through `CLAUDE_MEM_INSTALL_EXTRA_SKILLS`.

**Architecture:** `SkillSelection` parses, deduplicates, and validates extras against the source skills directory before producing a final selection. Claude Code cache/marketplace filtering, OpenCode copying, and the local marketplace-sync script consume the same policy. The fork owner refreshes with the compact preset and without extras.

**Tech Stack:** TypeScript, Bun test runner, Node.js CommonJS marketplace-sync script.

---

### Task 1: Define selection behavior with failing tests

**Files:**
- Modify: `tests/integration/skill-selection.test.ts`
- Modify: `tests/integration/opencode-installer.test.ts`
- Modify: `tests/install-non-tty.test.ts`

- [ ] **Step 1: Add SkillSelection tests for extras and rejection**

Store and restore `CLAUDE_MEM_INSTALL_EXTRA_SKILLS` in the fixture. Add a compact selection test using ` weekly-digests, babysit, babysit, ` and a directory containing the three compact skills, those two extras, and `standup`. Assert `kept` is `['babysit', 'knowledge-agent', 'learn-codebase', 'mem-search', 'weekly-digests']` and only `standup` is removed.

Add the rejection case below. It establishes the no-mutation guarantee before implementation.

```ts
it('rejects unknown extras without removing any skill directory', () => {
  process.env.CLAUDE_MEM_SKILL_SET = 'compact';
  process.env.CLAUDE_MEM_INSTALL_EXTRA_SKILLS = 'babisit';
  const skillsDir = join(tempDir, 'skills');
  for (const name of ['knowledge-agent', 'mem-search', 'learn-codebase', 'standup']) {
    writeSkill(skillsDir, name);
  }

  expect(() => filterClaudeMemSkillsDirectory(skillsDir))
    .toThrow('Unknown Claude-Mem extra skill: babisit');
  expect(existsSync(join(skillsDir, 'standup', 'SKILL.md'))).toBe(true);
});
```

- [ ] **Step 2: Add an OpenCode compact-plus-extras integration test**

Save and restore `CLAUDE_MEM_SKILL_SET` and `CLAUDE_MEM_INSTALL_EXTRA_SKILLS` in the existing OpenCode fixture. Set `compact` plus `babysit,weekly-digests`, call `installOpenCodeIntegration()`, assert its return value is `0`, assert the three compact skills and both extras contain `SKILL.md`, and assert `standup` is absent.

- [ ] **Step 3: Add the local sync-script contract test**

Near the existing `syncMarketplaceSource` checks in `tests/install-non-tty.test.ts`, add:

```ts
expect(syncMarketplaceSource).toContain('CLAUDE_MEM_INSTALL_EXTRA_SKILLS');
expect(syncMarketplaceSource).toContain('Unknown Claude-Mem extra skill');
```

- [ ] **Step 4: Run the focused tests and observe the red state**

Run: `bun test tests/integration/skill-selection.test.ts tests/integration/opencode-installer.test.ts tests/install-non-tty.test.ts`

Expected: FAIL because compact does not include the extras, `babisit` is not rejected, and the sync mirror has no extra-skills support.

### Task 2: Implement parsing, validation, and OpenCode selection

**Files:**
- Modify: `src/services/integrations/SkillSelection.ts`
- Modify: `src/services/integrations/OpenCodeInstaller.ts`

- [ ] **Step 1: Parse a stable list of requested extras**

Add this exported helper to `SkillSelection.ts`:

```ts
export function resolveClaudeMemExtraSkills(): readonly string[] {
  const configured = process.env.CLAUDE_MEM_INSTALL_EXTRA_SKILLS ?? '';
  return [...new Set(
    configured.split(',').map((skill) => skill.trim()).filter(Boolean),
  )];
}
```

- [ ] **Step 2: Resolve and validate the final names before filtering**

Add a private directory-listing helper, an unknown-extra assertion, and this exported resolver. The error text is shared by all TypeScript install paths.

```ts
export function resolveClaudeMemSkillNames(skillsDirectory: string): readonly string[] | null {
  const set = resolveClaudeMemSkillSet();
  const extras = resolveClaudeMemExtraSkills();
  const available = readdirSync(skillsDirectory)
    .sort()
    .filter((entry) => statSync(path.join(skillsDirectory, entry)).isDirectory());
  const availableSet = new Set(available);
  const unknown = extras.filter((skill) => !availableSet.has(skill));

  if (unknown.length > 0) {
    const label = unknown.length === 1 ? 'skill' : 'skills';
    throw new Error(
      `Unknown Claude-Mem extra ${label}: ${unknown.join(', ')}. Available bundled skills: ${available.join(', ')}`,
    );
  }

  const preset = claudeMemSkillAllowlist(set);
  return preset === null ? null : [...new Set([...preset, ...extras])];
}
```

Change `filterClaudeMemSkillsDirectory` so it returns early only for a missing directory, calls `resolveClaudeMemSkillNames` before deletion, and treats its `null` return as `full`. This validates extras under `full` too, while retaining `claudeMemSkillAllowlist() === null` for legacy callers.

- [ ] **Step 3: Preserve OpenCode’s previous skills on invalid input**

Replace the direct `claudeMemSkillAllowlist` import in `OpenCodeInstaller.ts` with `resolveClaudeMemSkillNames`. Give `installSelectedOpenCodeSkills` a `skillNames: readonly string[] | null` parameter. Calculate it before the destination is removed:

```ts
const skillNames = resolveClaudeMemSkillNames(skillsSourcePath);
mkdirSync(getOpenCodeSkillsDirectory(), { recursive: true });
rmSync(destinationPath, { recursive: true, force: true });
mkdirSync(destinationPath, { recursive: true });
const installedCount = installSelectedOpenCodeSkills(
  skillsSourcePath,
  destinationPath,
  skillNames,
);
```

- [ ] **Step 4: Run the TypeScript focused tests and observe green**

Run: `bun test tests/integration/skill-selection.test.ts tests/integration/opencode-installer.test.ts`

Expected: PASS; `babisit` fails before `standup` is removed, and OpenCode receives the same five compact-plus-extra skills.

### Task 3: Mirror the behavior in local sync and document it

**Files:**
- Modify: `scripts/sync-marketplace.cjs`
- Modify: `FORK_NOTES.md`
- Test: `tests/install-non-tty.test.ts`

- [ ] **Step 1: Mirror extra parsing and strict validation in `filterSkills`**

Add `resolveExtraSkills()` with the TypeScript parser’s trim/filter/deduplicate behavior. In `filterSkills(skillsDir)`, enumerate directory names, reject unavailable extras using the exact `Unknown Claude-Mem extra skill(s): … Available bundled skills: …` wording, then return for `full` only after validation. Otherwise add extras to the selected preset’s `Set` before removal.

- [ ] **Step 2: Add the fork-facing configuration reference**

Append this bullet to the existing skill-set section of `FORK_NOTES.md`:

```md
- `CLAUDE_MEM_INSTALL_EXTRA_SKILLS` optionally extends `default` or `compact`
  with comma-separated bundled skill names (for example,
  `CLAUDE_MEM_SKILL_SET=compact CLAUDE_MEM_INSTALL_EXTRA_SKILLS=babysit,weekly-digests`).
  Names are trimmed and deduplicated; an unknown name aborts installation with
  the available names instead of silently omitting it. `full` still validates
  the variable but keeps every bundled skill.
```

- [ ] **Step 3: Run the installer/sync contract test**

Run: `bun test tests/install-non-tty.test.ts`

Expected: PASS.

### Task 4: Verify and refresh the compact local installation

**Files:**
- Generated by build: `plugin/scripts/*.cjs`, `plugin/ui/viewer-bundle.js`
- External installation: `~/.claude/plugins/marketplaces/ormequ`, active `~/.claude/plugins/cache/ormequ/claude-mem/*`

- [ ] **Step 1: Run static and fork-focused verification**

Run:

```bash
bun run typecheck
bun test tests/telemetry/consent.test.ts tests/integration/skill-selection.test.ts tests/integration/opencode-installer.test.ts tests/install-non-tty.test.ts tests/services/sqlite/observations-by-file-merged-scoping.test.ts tests/hooks/file-context.test.ts
```

Expected: both commands exit `0`.

- [ ] **Step 2: Build and sync with compact only**

Run:

```bash
env -u CLAUDE_MEM_INSTALL_EXTRA_SKILLS CLAUDE_MEM_SKILL_SET=compact npm run build-and-sync
```

Expected: the marketplace and active cache are rebuilt from this fork, receive only `knowledge-agent`, `mem-search`, and `learn-codebase`, and the worker restarts.

- [ ] **Step 3: Verify the external install**

Run:

```bash
find ~/.claude/plugins/marketplaces/ormequ/plugin/skills -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort
claude plugin validate .
npm run worker:status
```

Expected: exactly the three compact names, a successful plugin validation, and a healthy worker status.

- [ ] **Step 4: Commit only feature files**

Run:

```bash
git add FORK_NOTES.md scripts/sync-marketplace.cjs src/services/integrations/SkillSelection.ts src/services/integrations/OpenCodeInstaller.ts tests/integration/skill-selection.test.ts tests/integration/opencode-installer.test.ts tests/install-non-tty.test.ts
git commit --only FORK_NOTES.md scripts/sync-marketplace.cjs src/services/integrations/SkillSelection.ts src/services/integrations/OpenCodeInstaller.ts tests/integration/skill-selection.test.ts tests/integration/opencode-installer.test.ts tests/install-non-tty.test.ts -m "feat(skills): allow validated extra install skills"
```

Expected: one feature commit while pre-existing staged files retain their previous index state.
