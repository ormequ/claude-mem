#!/usr/bin/env bun
/**
 * Replay one real day of tool events through a generation model and record what
 * it costs and what it returns.
 *
 * The point is fidelity: prompts come from the same builders the worker uses
 * (`src/sdk/prompts.ts`), the conversation history grows exactly as
 * OpenAICompatibleProvider grows it, and request parameters match
 * OpenRouterProvider's. A harness that rebuilds the prompt by hand measures the
 * harness, not the generator.
 *
 * Nothing is written to the store. Results go to a JSONL file.
 *
 * Usage:
 *   bun scripts/model-replay.ts --day 2026-08-13 --arm dry
 *   bun scripts/model-replay.ts --day 2026-08-13 --arm glm-4.7 --out docs-local/model-replay/glm-4.7.jsonl
 *   bun scripts/model-replay.ts --day 2026-08-13 --arm luna --limit 20
 */

import { readFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { Database } from 'bun:sqlite';
import { buildInitPrompt, buildContinuationPrompt, buildObservationPrompt } from '../src/sdk/prompts.js';
import type { ModeConfig } from '../src/services/domain/types.js';

const HOME = homedir();
const DB_PATH = join(HOME, '.claude-mem', 'claude-mem.db');
const SETTINGS_PATH = join(HOME, '.claude-mem', 'settings.json');
const PROJECTS_DIR = join(HOME, '.claude', 'projects');
const MODE_PATH = join(import.meta.dir, '..', 'plugin', 'modes', 'code.json');

// ---------------------------------------------------------------- arms

interface Arm {
  name: string;
  kind: 'dry' | 'openai-compatible' | 'codex';
  model?: string;
  /** Codex only: ask for a JSON-schema-shaped final response. */
  outputSchema?: boolean;
}

const ARMS: Record<string, Arm> = {
  'dry': { name: 'dry', kind: 'dry' },
  'glm-4.7': { name: 'glm-4.7', kind: 'openai-compatible', model: 'glm-4.7' },
  'glm-5.3': { name: 'glm-5.3', kind: 'openai-compatible', model: 'glm-5.3' },
  'luna': { name: 'luna', kind: 'codex', model: 'gpt-5.6-luna' },
  'luna-schema': { name: 'luna-schema', kind: 'codex', model: 'gpt-5.6-luna', outputSchema: true },
};

// ---------------------------------------------------------------- args

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
}

const DAY = arg('--day') ?? '2026-08-13';
const ARM_NAME = arg('--arm') ?? 'dry';
const LIMIT = Number(arg('--limit') ?? '0');           // 0 = no cap
const SESSION_LIMIT = Number(arg('--sessions') ?? '0');
/**
 * Minimum spacing between calls. The z.ai coding endpoint answers 429 code 1302
 * ("Rate limit reached for requests") to bursts while the plan is barely used —
 * it is a request-rate ceiling, not an exhausted quota — and unpaced replays
 * spend their run retrying instead of measuring.
 */
const MIN_INTERVAL_MS = Number(arg('--interval') ?? '5000');
/** Recovery wait after a 429, and how many times to sit it out. */
const RATE_LIMIT_WAIT_MS = Number(arg('--rate-wait') ?? '75000');
const RATE_LIMIT_RETRIES = Number(arg('--rate-retries') ?? '3');
/** Tool events per call. 1 reproduces today's behaviour; higher is the batching experiment. */
const BATCH = Math.max(1, Number(arg('--batch') ?? '1'));
/** Cap on events (not calls), so batched and unbatched runs cover the same material. */
const EVENT_LIMIT = Number(arg('--events') ?? '0');
const OUT = arg('--out') ?? `docs-local/model-replay/${DAY}-${ARM_NAME}.jsonl`;

/** Mean assistant reply on the replayed day: 591 output tokens at 4 chars/token. */
const DRY_ASSISTANT_CHARS = 2364;

/** SessionMessageBuffer.drain's idle timeout — the generator aborts after this. */
const GENERATOR_IDLE_TIMEOUT_MS = 180_000;

/** `per-session` keeps one Codex thread per replayed history; `per-call` resets it every turn. */
const CODEX_THREAD_SCOPE = (arg('--thread') ?? 'per-session') as 'per-session' | 'per-call';

/** Codex reasoning effort: "minimal" | "low" | "medium" | "high" | "xhigh". */
const CODEX_EFFORT = (arg('--effort') ?? 'low') as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

const arm = ARMS[ARM_NAME];
if (!arm) {
  console.error(`unknown arm "${ARM_NAME}" — known: ${Object.keys(ARMS).join(', ')}`);
  process.exit(1);
}

// ---------------------------------------------------------------- inputs

interface ReplaySession {
  sessionDbId: number;
  contentSessionId: string;
  project: string;
  userPrompt: string;
  transcript: string;
}

/**
 * Sessions that PRODUCED work on the given day, joined to their Claude Code
 * transcript. Selecting by `started_at` instead drops the long-running sessions
 * that opened the day before — on one measured day that was the session holding
 * 296 of the day's 376 observations, i.e. most of the volume and all of the
 * deep history.
 */
function findSessions(day: string): ReplaySession[] {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.query<{
    id: number; content_session_id: string; project: string | null; user_prompt: string | null;
  }, [string]>(
    `SELECT s.id, s.content_session_id, s.project, s.user_prompt, count(o.id) AS obs
       FROM observations o
       JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
      WHERE date(o.created_at) = ?
        AND s.content_session_id IS NOT NULL
      GROUP BY s.content_session_id
      ORDER BY obs DESC`
  ).all(day);
  db.close();

  const transcripts = new Map<string, string>();
  for (const projectDir of readdirSync(PROJECTS_DIR)) {
    const full = join(PROJECTS_DIR, projectDir);
    let entries: string[];
    try { entries = readdirSync(full); } catch { continue; }
    for (const file of entries) {
      if (file.endsWith('.jsonl')) transcripts.set(file.replace(/\.jsonl$/, ''), join(full, file));
    }
  }

  const sessions: ReplaySession[] = [];
  for (const row of rows) {
    const transcript = transcripts.get(row.content_session_id);
    if (!transcript) continue;                       // transcript rotated away
    sessions.push({
      sessionDbId: row.id,
      contentSessionId: row.content_session_id,
      project: row.project ?? 'unknown',
      userPrompt: row.user_prompt ?? '',
      transcript,
    });
  }
  return SESSION_LIMIT > 0 ? sessions.slice(0, SESSION_LIMIT) : sessions;
}

interface ToolEvent {
  toolName: string;
  toolInput: unknown;
  toolResponse: unknown;
  cwd?: string;
  promptNumber: number;
  epoch: number;
}

/**
 * Reconstruct the events the PostToolUse hook would have enqueued. The hook
 * filters nothing but excluded projects, so every tool_use with a matching
 * tool_result is one event.
 */
function parseTranscript(path: string): ToolEvent[] {
  const pending = new Map<string, { toolName: string; toolInput: unknown; cwd?: string; epoch: number; promptNumber: number }>();
  const events: ToolEvent[] = [];
  let promptNumber = 0;

  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }

    const content = entry?.message?.content;
    const epoch = entry?.timestamp ? Date.parse(entry.timestamp) : Date.now();

    if (entry.type === 'user') {
      if (typeof content === 'string') { promptNumber++; continue; }
      if (Array.isArray(content)) {
        let sawToolResult = false;
        for (const block of content) {
          if (block?.type !== 'tool_result') continue;
          sawToolResult = true;
          const open = pending.get(block.tool_use_id);
          if (!open) continue;
          pending.delete(block.tool_use_id);
          events.push({
            toolName: open.toolName,
            toolInput: open.toolInput,
            toolResponse: block.content,
            cwd: open.cwd ?? entry.cwd,
            promptNumber: open.promptNumber,
            epoch: open.epoch,
          });
        }
        if (!sawToolResult) promptNumber++;          // a typed prompt, not a tool reply
      }
      continue;
    }

    if (entry.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type !== 'tool_use') continue;
        pending.set(block.id, {
          toolName: block.name,
          toolInput: block.input,
          cwd: entry.cwd,
          epoch,
          promptNumber: Math.max(promptNumber, 1),
        });
      }
    }
  }
  return events;
}

// ---------------------------------------------------------------- providers

interface CallResult {
  content: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  error?: string;
}

interface Message { role: 'user' | 'assistant'; content: string; }

function loadSettings(): Record<string, string> {
  const raw = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
  return (raw.env && typeof raw.env === 'object') ? raw.env : raw;
}

async function callOpenAICompatible(history: Message[], model: string, settings: Record<string, string>): Promise<CallResult> {
  const apiUrl = settings.CLAUDE_MEM_OPENROUTER_BASE_URL;
  const apiKey = settings.CLAUDE_MEM_OPENROUTER_API_KEY;
  if (!apiUrl || !apiKey) return { content: '', error: 'missing base url or api key' };

  const response = await fetch(`${apiUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'claude-mem model-replay',
    },
    // Same parameters as OpenRouterProvider.fetchChatCompletion.
    body: JSON.stringify({ model, messages: history, temperature: 0.3, max_tokens: 4096 }),
  });

  if (!response.ok) {
    return { content: '', error: `HTTP ${response.status}: ${(await response.text()).slice(0, 300)}` };
  }
  const data: any = await response.json();
  return {
    content: data?.choices?.[0]?.message?.content ?? '',
    inputTokens: data?.usage?.prompt_tokens,
    outputTokens: data?.usage?.completion_tokens,
    cachedInputTokens: data?.usage?.prompt_tokens_details?.cached_tokens,
  };
}

/**
 * Codex SDK arm. Loaded lazily so the other arms need no dependency; the SDK
 * authenticates with the ChatGPT subscription already cached in ~/.codex.
 */
let codexThread: any = null;
async function callCodex(history: Message[], model: string, outputSchema: boolean): Promise<CallResult> {
  const { Codex } = await import('@openai/codex-sdk');
  if (!codexThread) {
    codexThread = new Codex().startThread({
      model,
      // The task is extraction, not agency: reasoning tokens bill at the output
      // rate (30 credits/1M against 5 for input), and a default-effort thread
      // spent most of its output budget thinking rather than answering.
      modelReasoningEffort: CODEX_EFFORT,
      // Nothing here should touch the disk or the network — every tool attempt
      // is another billed turn in the agent loop.
      sandboxMode: 'read-only',
      networkAccessEnabled: false,
      webSearchEnabled: false,
      skipGitRepoCheck: true,
    });
    // A fresh thread has never seen the mode instructions. The real provider
    // spends a call on them too (`startSession` queries the init prompt before
    // the first observation), so this is fidelity, not overhead — except in
    // per-call mode, where the instructions are prepended to every prompt.
    if (CODEX_THREAD_SCOPE === 'per-session') await codexThread.run(history[0]!.content);
  }
  // The provider resends the whole history each turn; the SDK keeps its own
  // thread, so send only the newest user turn and let the thread carry the rest.
  // `--thread per-call` throws the thread away after every observation, so the
  // model sees the mode instructions and one event instead of the whole session.
  // The accumulating thread bills the entire prior conversation on every turn:
  // measured 40k input tokens on call 1 and 1.33M on call 35.
  const latest = CODEX_THREAD_SCOPE === 'per-call'
    ? `${history[0]!.content}\n\n${history[history.length - 1]!.content}`
    : history[history.length - 1]!.content;
  const turn = await codexThread.run(latest, outputSchema ? { outputSchema: OBSERVATION_SCHEMA } : undefined);
  if (CODEX_THREAD_SCOPE === 'per-call') codexThread = null;
  const usage = turn?.usage ?? {};
  return {
    content: turn?.finalResponse ?? '',
    inputTokens: usage.input_tokens ?? usage.inputTokens,
    outputTokens: usage.output_tokens ?? usage.outputTokens,
    cachedInputTokens: usage.cached_input_tokens ?? usage.cachedInputTokens,
  };
}

const OBSERVATION_SCHEMA = {
  type: 'object',
  properties: {
    observations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          subtitle: { type: 'string' },
          narrative: { type: 'string' },
          facts: { type: 'array', items: { type: 'string' } },
          concepts: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'narrative', 'facts', 'concepts'],
        additionalProperties: false,
      },
    },
  },
  required: ['observations'],
  additionalProperties: false,
};

// ---------------------------------------------------------------- scoring

const mode: ModeConfig = JSON.parse(readFileSync(MODE_PATH, 'utf-8'));
const ALLOWED_CONCEPTS = new Set((mode as any).observation_concepts?.map((c: any) => c.id) ?? []);

const ALLOWED_TYPES = new Set((mode as any).observation_types?.map((t: any) => t.id) ?? []);

/**
 * What the parser would accept, plus the compliance numbers. Concepts are
 * `<concepts><concept>id</concept>…`, not a comma-separated attribute — reading
 * them the other way scores every model as perfectly compliant.
 */
function scoreResponse(content: string): {
  blocks: number; concepts: number; offVocab: number; types: number; offType: number; parseOk: boolean;
} {
  const blocks = content.match(/<observation>/g)?.length ?? 0;
  const conceptValues = [...content.matchAll(/<concept>([^<]*)<\/concept>/g)].map(m => m[1]!.trim());
  const typeValues = [...content.matchAll(/<type>([^<]*)<\/type>/g)].map(m => m[1]!.trim());
  const empty = content.trim().length === 0;
  return {
    blocks,
    concepts: conceptValues.length,
    offVocab: conceptValues.filter(c => !ALLOWED_CONCEPTS.has(c)).length,
    types: typeValues.length,
    offType: typeValues.filter(t => !ALLOWED_TYPES.has(t)).length,
    parseOk: blocks > 0 || empty,
  };
}

// ---------------------------------------------------------------- run

async function main() {
  const settings = loadSettings();
  const sessions = findSessions(DAY);
  if (sessions.length === 0) {
    console.error(`no sessions with transcripts found for ${DAY}`);
    process.exit(1);
  }

  mkdirSync(dirname(OUT), { recursive: true });
  if (existsSync(OUT)) {
    console.error(`refusing to append to existing ${OUT} — move it aside first`);
    process.exit(1);
  }

  let calls = 0;
  let eventsSent = 0;
  let lastCallAt = 0;
  const totals = { input: 0, output: 0, cached: 0, blocks: 0, concepts: 0, offVocab: 0, errors: 0, promptChars: 0 };

  for (const session of sessions) {
    // Whole-file replay would carry days of a long-running session's events; the
    // day is the unit being costed, so keep only what happened on it.
    const dayStart = Date.parse(`${DAY}T00:00:00`);
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    const events = parseTranscript(session.transcript)
      .filter(e => e.epoch >= dayStart && e.epoch < dayEnd);
    if (events.length === 0) continue;

    let history: Message[] = [];
    const openHistory = (promptNumber: number) => {
      history = [{
        role: 'user',
        content: promptNumber === 1
          ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
          : buildContinuationPrompt(session.userPrompt, promptNumber, session.contentSessionId, mode),
      }];
    };
    openHistory(events[0]!.promptNumber);
    let lastEpoch = events[0]!.epoch;

    for (let cursor = 0; cursor < events.length; cursor += BATCH) {
      if (LIMIT > 0 && calls >= LIMIT) break;
      if (EVENT_LIMIT > 0 && eventsSent >= EVENT_LIMIT) break;
      const batch = events.slice(cursor, cursor + BATCH);
      const event = batch[0]!;

      // A gap longer than the generator's idle timeout means the real generator
      // aborted and the next ingest started a fresh one with a continuation
      // prompt. Without this the replayed history grows without bound and every
      // later call is billed against a context that never existed.
      if (event.epoch - lastEpoch > GENERATOR_IDLE_TIMEOUT_MS) {
        openHistory(event.promptNumber);
        codexThread = null;
      }
      lastEpoch = batch[batch.length - 1]!.epoch;
      eventsSent += batch.length;

      // One turn carrying every event in the batch. The contract already allows
      // several <observation> blocks per reply, so nothing about the output
      // shape changes — only how many turns it takes to get there.
      history.push({
        role: 'user',
        content: batch.map(e => buildObservationPrompt({
          id: 0,
          tool_name: e.toolName,
          tool_input: JSON.stringify(e.toolInput),
          tool_output: JSON.stringify(e.toolResponse),
          created_at_epoch: e.epoch,
          cwd: e.cwd,
        })).join('\n\n'),
      });

      const promptChars = history.reduce((sum, m) => sum + m.content.length, 0);
      totals.promptChars += promptChars;
      calls++;

      if (arm.kind === 'dry') {
        appendFileSync(OUT, JSON.stringify({
          arm: arm.name, session: session.contentSessionId, call: calls,
          tools: batch.map(e => e.toolName), events: batch.length, promptChars, turns: history.length,
        }) + '\n');
        // Nothing came back, so keep the shape of a real run: an assistant turn
        // the size the logs report for a real one (591 output tokens × 4 chars),
        // or the history stops growing and every later prompt is understated.
        history.push({ role: 'assistant', content: 'x'.repeat(DRY_ASSISTANT_CHARS) });
        continue;
      }

      const sinceLast = Date.now() - lastCallAt;
      if (lastCallAt > 0 && sinceLast < MIN_INTERVAL_MS) {
        await new Promise(resolve => setTimeout(resolve, MIN_INTERVAL_MS - sinceLast));
      }
      lastCallAt = Date.now();

      const startedAt = Date.now();
      let result: CallResult;
      // Measured on the z.ai coding endpoint: once the per-minute ceiling trips,
      // every request is refused regardless of size, and it clears after ~75s.
      // Two attempts capped at 30s — the plugin's current policy — expire inside
      // that window and turn a recoverable pause into a dropped observation.
      for (let attempt = 0; ; attempt++) {
        try {
          result = arm.kind === 'codex'
            ? await callCodex(history, arm.model!, arm.outputSchema ?? false)
            : await callOpenAICompatible(history, arm.model!, settings);
        } catch (error) {
          result = { content: '', error: error instanceof Error ? error.message : String(error) };
        }
        const rateLimited = result.error && /\b429\b|rate limit/i.test(result.error);
        if (!rateLimited || attempt >= RATE_LIMIT_RETRIES) break;
        console.error(`rate limited, waiting ${RATE_LIMIT_WAIT_MS / 1000}s (attempt ${attempt + 1})`);
        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_WAIT_MS));
      }
      const latencyMs = Date.now() - startedAt;

      const score = scoreResponse(result.content);
      if (result.error) totals.errors++;
      totals.input += result.inputTokens ?? 0;
      totals.output += result.outputTokens ?? 0;
      totals.cached += result.cachedInputTokens ?? 0;
      totals.blocks += score.blocks;
      totals.concepts += score.concepts;
      totals.offVocab += score.offVocab;

      appendFileSync(OUT, JSON.stringify({
        arm: arm.name, session: session.contentSessionId, call: calls,
        tools: batch.map(e => e.toolName), events: batch.length,
        promptChars, turns: history.length, latencyMs,
        inputTokens: result.inputTokens, outputTokens: result.outputTokens,
        cachedInputTokens: result.cachedInputTokens,
        ...score, error: result.error, content: result.content,
      }) + '\n');

      if (result.content) history.push({ role: 'assistant', content: result.content });
      if (result.error) {
        console.error(`call ${calls} failed: ${result.error}`);

      }
    }

    codexThread = null;                              // one thread per session
    if (LIMIT > 0 && calls >= LIMIT) break;
    if (EVENT_LIMIT > 0 && eventsSent >= EVENT_LIMIT) break;
  }

  console.log(JSON.stringify({
    arm: arm.name, day: DAY, batch: BATCH, sessions: sessions.length, calls, eventsSent,
    avgPromptChars: Math.round(totals.promptChars / Math.max(calls, 1)),
    ...totals,
  }, null, 2));
}

main();
