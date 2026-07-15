// scripts/rank-replay.ts
//
// FORK tool: replay read-hook ranking variants against live DB rows.
// Usage:
//   bun scripts/rank-replay.ts --project kedo \
//     --file "resources/js/Pages/Dev/Gallery.vue" --killer 24717 \
//     --file "app/Services/Bitrix24/AbsencesImporter.php" --killer 25165 --killer 25175
//
// Rule (FORK_NOTES): no ranking change ships without a green run here —
// every killer stays in the top-15 and the change beats 'upstream' on a
// stated metric. Fixtures for ranking tests come from real rows only.
//
// 'upstream' is not a hand-copied mirror: it IS the shipped scorer, imported
// directly from src/cli/handlers/file-context.ts, so fidelity is a type
// error rather than a human-maintained claim about a copy.
//
// Simplification vs production: the by-file lookup in file-context.ts joins
// files_read/files_modified via an exact json_each match; this replay uses a
// LIKE substring match on the raw JSON text instead. That widens the raw
// candidate set fetched from the DB and, when the 40-row cap binds, can shift
// the window (extra matched rows can displace the oldest exact-match rows
// production would have seen) — acceptable for a replay gate, since the
// scorer itself still requires an exact normalized-path match against
// files_modified, same as production. This simplification is in the DB
// query, not in the scorer under test — the scorer is the real one.
import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import { deduplicateObservations, type ObservationRow } from '../src/cli/handlers/file-context.js';

const DISPLAY_LIMIT = 15;
// deduplicateObservations applies its own display cap internally
// (slice(0, limit)). To still be able to report an out-of-cap rank for a
// killer (e.g. "rank 21 OUT"), call it with a large limit for ranking
// purposes and compare the result against DISPLAY_LIMIT ourselves for the
// IN/OUT verdict — preserves today's output semantics exactly.
const RANK_LIMIT = 1000;

type Row = ObservationRow;

// Register candidate variants here. Each returns the full ranked id order
// (no cap applied by the harness — variants are called with RANK_LIMIT so
// out-of-cap ranks stay visible).
const VARIANTS: Record<string, (rows: Row[], target: string, limit: number) => number[]> = {
  upstream: (rows, target, limit) => deduplicateObservations(rows, target, limit).map(o => o.id),
};

// --- arg parsing: pairs of --file <path> followed by its --killer <id>s ---
const USAGE = 'usage: bun scripts/rank-replay.ts [--project p] --file <path> [--killer <id>]... [--file ...]';

function fail(message: string): never {
  console.error(`${USAGE}\n${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
let project = 'kedo';
const files: { path: string; killers: number[] }[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--project') {
    const value = args[++i];
    if (value === undefined) fail('--project requires a value');
    project = value;
  } else if (args[i] === '--file') {
    const value = args[++i];
    if (value === undefined) fail('--file requires a value');
    files.push({ path: value, killers: [] });
  } else if (args[i] === '--killer') {
    if (files.length === 0) fail('--killer must come after a --file');
    const raw = args[++i];
    const id = Number(raw);
    if (raw === undefined || !Number.isInteger(id)) fail(`--killer expects an integer id, got: ${raw}`);
    files[files.length - 1].killers.push(id);
  } else {
    fail(`unrecognized argument: ${args[i]}`);
  }
}
if (files.length === 0) {
  fail('at least one --file is required');
}

const db = new Database(join(homedir(), '.claude-mem', 'claude-mem.db'), { readonly: true });
let anyKillerOut = false;
for (const f of files) {
  const rows = db.query<Row, { $path: string; $project: string }>(`
    SELECT id, memory_session_id, title, type, created_at_epoch, files_read, files_modified, concepts
    FROM observations
    WHERE (files_modified LIKE '%' || $path || '%' OR files_read LIKE '%' || $path || '%')
      AND (project = $project OR merged_into_project = $project)
    ORDER BY created_at_epoch DESC LIMIT 40
  `).all({ $path: f.path, $project: project });
  console.log(`\n=== ${f.path} (raw=${rows.length}) ===`);
  for (const [name, scorer] of Object.entries(VARIANTS)) {
    const order = scorer(rows, f.path, RANK_LIMIT);
    const marks = f.killers.map(k => {
      const r = order.indexOf(k) + 1;
      const inTop = r > 0 && r <= DISPLAY_LIMIT;
      if (!inTop) anyKillerOut = true;
      return `#${k}: rank ${r || 'absent'} ${inTop ? 'IN' : 'OUT'}`;
    });
    console.log(`  ${name.padEnd(20)} ${marks.join(' | ') || `top3=${order.slice(0, 3).join(',')}`}`);
  }
}
db.close();

// Gate semantics: any named killer not in the top-15 fails the run. No
// killers named → nothing to fail on → exit 0 (eyeball-only invocation).
if (anyKillerOut) {
  process.exit(1);
}
