#!/usr/bin/env bun
/**
 * Score a model-replay JSONL on the three prompt-level defects the blind judges
 * named, so a prompt change can be measured instead of argued about.
 *
 *   bun scripts/replay-score.ts docs-local/model-replay/*.jsonl
 *
 * - repeats:    two observations in one run whose title normalises to the same
 *               string, or whose fact sets overlap almost entirely. This is the
 *               handoff-boundary re-recording: the continuation prompt makes the
 *               generator restate windows it already wrote.
 * - ephemeral:  facts naming scaffolding that is dead by tomorrow — scratchpad
 *               and temp paths, background-task and agent ids, pids, wall-clock
 *               durations of a test run.
 * - malformed:  <concepts> closed with </concept>. extractArrayElements needs the
 *               plural close, so every concept in such a block is silently lost.
 */

import { readFileSync } from 'fs';

const files = process.argv.slice(2).filter(a => !a.startsWith('--'));

const EPHEMERAL: Array<[string, RegExp]> = [
  ['tmp/scratchpad path', /\/(?:private\/)?tmp\/[\w.\-/]*|scratchpad/i],
  ['background task id', /\b(?:task|agent|job)[ _-]?id\b|\bb[a-z0-9]{8}\b(?=\.output)|\.output\b/i],
  ['pid', /\bpid\s*[:=]?\s*\d{3,}/i],
  ['run duration', /\b\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds|minutes)\b.*\b(?:test|suite|run|build|took|elapsed)\b|\b(?:test|suite|run|build|took|elapsed)\b.*\b\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds)\b/i],
  ['session/uuid', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
];

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function tag(block: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g');
  let m;
  while ((m = re.exec(block)) !== null) out.push(m[1].trim());
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

for (const file of files) {
  const blocks: Array<{ title: string; facts: Set<string>; text: string }> = [];
  let malformed = 0;
  let calls = 0;

  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    const content: string = rec.content ?? '';
    if (rec.content !== undefined) calls++;
    for (const blk of content.match(/<observation>[\s\S]*?<\/observation>/g) ?? []) {
      if (blk.includes('<concepts>') && !blk.includes('</concepts>')) malformed++;
      const facts = tag(blk, 'fact').map(norm).filter(Boolean);
      blocks.push({
        title: norm(tag(blk, 'title')[0] ?? ''),
        facts: new Set(facts),
        text: [tag(blk, 'title')[0] ?? '', ...tag(blk, 'subtitle'), ...tag(blk, 'fact'), ...tag(blk, 'narrative')].join('\n'),
      });
    }
  }

  // repeats: any later block that duplicates an earlier one
  let repeats = 0;
  const repeatExamples: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    for (let j = 0; j < i; j++) {
      const same = blocks[i].title && blocks[i].title === blocks[j].title;
      const overlap = jaccard(blocks[i].facts, blocks[j].facts) >= 0.6;
      if (same || overlap) {
        repeats++;
        if (repeatExamples.length < 3) repeatExamples.push(blocks[i].title.slice(0, 70));
        break;
      }
    }
  }

  const ephemeralHits: Record<string, number> = {};
  let ephemeralBlocks = 0;
  for (const b of blocks) {
    let hit = false;
    for (const [label, re] of EPHEMERAL) {
      if (re.test(b.text)) { ephemeralHits[label] = (ephemeralHits[label] ?? 0) + 1; hit = true; }
    }
    if (hit) ephemeralBlocks++;
  }

  const pct = (n: number) => blocks.length ? `${((n / blocks.length) * 100).toFixed(0)}%` : '-';
  console.log(
    `${file.split('/').pop()}\n` +
    `  calls ${calls}  blocks ${blocks.length}\n` +
    `  repeats    ${repeats} (${pct(repeats)})  e.g. ${repeatExamples.join(' | ') || '-'}\n` +
    `  ephemeral  ${ephemeralBlocks} (${pct(ephemeralBlocks)})  ${JSON.stringify(ephemeralHits)}\n` +
    `  malformed  ${malformed} (${pct(malformed)})`
  );
}
