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
// Simplification vs production: the by-file lookup in file-context.ts joins
// files_read/files_modified via an exact json_each match; this replay uses a
// LIKE substring match on the raw JSON text instead. That only widens the raw
// candidate set fetched from the DB — the scorer below still requires an
// exact normalized-path match against files_modified, same as production.
// Acceptable for a replay gate; not runtime-coupled to the hook.
import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';

const DISPLAY_LIMIT = 15;

interface Row {
  id: number; title: string | null; type: string; created_at_epoch: number;
  files_read: string | null; files_modified: string | null; concepts: string | null;
}

function parseArr(s: string | null): string[] {
  if (!s || !s.startsWith('[')) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}

function dedup(rows: Row[]): Row[] {
  const seen = new Set<string>(); const out: Row[] = [];
  for (const o of rows) {
    const key = (o.title ?? '').toLowerCase().replace(/\s+/g, ' ').trim() || `no-title-${o.id}`;
    if (!seen.has(key)) { seen.add(key); out.push(o); }
  }
  return out;
}

// Mirrors deduplicateObservations in src/cli/handlers/file-context.ts
// (as of the concept-boost commit): exact normalized-path match against
// files_modified (production compares `f.replace(/\\/g,'/') === target`, not
// endsWith), plus the additive decision-concept boost applied after the
// upstream specificity score.
const BOOST_CONCEPTS = new Set(['decision', 'gotcha', 'trade-off', 'problem-solution']);
const CONCEPT_BOOST = 2;

function specificity(o: Row, target: string): number {
  const fr = parseArr(o.files_read), fm = parseArr(o.files_modified);
  const total = fr.length + fm.length;
  const normalizedTarget = target.replace(/\\/g, '/');
  const inMod = fm.some(f => f.replace(/\\/g, '/') === normalizedTarget);
  let s = 0;
  if (inMod) s += 2;
  if (total <= 3) s += 2; else if (total <= 8) s += 1;
  if (parseArr(o.concepts).some(c => BOOST_CONCEPTS.has(c))) s += CONCEPT_BOOST;
  return s;
}

// Register candidate variants here. 'upstream' is the shipped scorer — keep
// it byte-equivalent to deduplicateObservations in src/cli/handlers/file-context.ts.
const VARIANTS: Record<string, (o: Row, target: string) => number> = {
  upstream: specificity,
};

function rank(rows: Row[], target: string, scorer: (o: Row, t: string) => number): number[] {
  return dedup(rows)
    .map(o => ({ o, s: scorer(o, target) }))
    .sort((a, b) => b.s - a.s) // stable: ties keep newest-first DB order
    .map(x => x.o.id);
}

// --- arg parsing: pairs of --file <path> followed by its --killer <id>s ---
const args = process.argv.slice(2);
let project = 'kedo';
const files: { path: string; killers: number[] }[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--project') project = args[++i];
  else if (args[i] === '--file') files.push({ path: args[++i], killers: [] });
  else if (args[i] === '--killer') files[files.length - 1].killers.push(Number(args[++i]));
}
if (files.length === 0) {
  console.error('usage: bun scripts/rank-replay.ts [--project p] --file <path> [--killer <id>]... [--file ...]');
  process.exit(1);
}

const db = new Database(join(homedir(), '.claude-mem', 'claude-mem.db'), { readonly: true });
for (const f of files) {
  const rows = db.query<Row, { $path: string; $project: string }>(`
    SELECT id, title, type, created_at_epoch, files_read, files_modified, concepts
    FROM observations
    WHERE (files_modified LIKE '%' || $path || '%' OR files_read LIKE '%' || $path || '%')
      AND (project = $project OR merged_into_project = $project)
    ORDER BY created_at_epoch DESC LIMIT 40
  `).all({ $path: f.path, $project: project });
  console.log(`\n=== ${f.path} (raw=${rows.length}) ===`);
  for (const [name, scorer] of Object.entries(VARIANTS)) {
    const order = rank(rows, f.path, scorer);
    const marks = f.killers.map(k => {
      const r = order.indexOf(k) + 1;
      return `#${k}: rank ${r || 'absent'} ${r > 0 && r <= DISPLAY_LIMIT ? 'IN' : 'OUT'}`;
    });
    console.log(`  ${name.padEnd(20)} ${marks.join(' | ') || `top3=${order.slice(0, 3).join(',')}`}`);
  }
}
db.close();
