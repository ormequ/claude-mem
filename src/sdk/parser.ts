
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import { ModeManager } from '../services/domain/ModeManager.js';
import { DATA_DIR } from '../shared/paths.js';

// TODO(#2233): migrate to Anthropic tool-use API for deterministic JSON output. This text-XML path is the bridge.
// Only strip fences when the entire payload is a single fenced block. Stripping
// the first opening + last closing fence anywhere in the string can corrupt
// content that contains internal fenced examples or surrounding prose
// (CodeRabbit review on PR #2282).
function stripCodeFences(text: string): string {
  const match = text.match(/^\s*```(?:xml)?\s*\n([\s\S]*?)\n```\s*$/i);
  return match ? match[1] : text;
}

export interface ParsedObservation {
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  files_read: string[];
  files_modified: string[];
}

export interface ParsedSummary {
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
  skipped?: boolean;
  skip_reason?: string | null;
}

export type ParseResult =
  | { valid: true; observations: ParsedObservation[]; summary: ParsedSummary | null }
  | { valid: false };

// FORK: write-time vocabulary enforcement. The model ignores the prompt-level
// enum at scale (50% of stored concept values were off-vocabulary; the Z.AI
// endpoint silently ignores response_format/json_schema, so constrained
// decoding is unavailable). The parser is the one chokepoint every
// observation passes through.
export function filterConcepts(
  concepts: string[],
  allowed: ReadonlySet<string>,
): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const c of concepts) {
    const canonical = canonicalizeConcept(c);
    if (!allowed.has(canonical)) {
      dropped.push(c);
      continue;
    }
    // Store the canonical spelling, not what the model typed: the injection SQL
    // matches exactly. Two spellings of one concept collapse to one entry.
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    kept.push(canonical);
  }
  return { kept, dropped };
}

// A separator slip is not an off-vocabulary answer. Measured 2026-07-30 on live
// drop stats: `how it-works` (a space for the hyphen) was thrown away 4 times
// while every other drop that day was a genuine topic word (`configuration`,
// `architecture`, `storage`). Exact-match on the raw string turns a typo into
// silent signal loss, so fold case and separators before deciding.
function canonicalizeConcept(concept: string): string {
  return concept
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

function recordConceptDrops(dropped: string[], correlationId?: string | number): void {
  logger.debug('PARSER', 'Dropped off-vocabulary concepts', { correlationId, dropped });
  try {
    const dir = join(DATA_DIR, 'state');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ts: Date.now(), dropped, correlationId: correlationId ?? null });
    appendFileSync(join(dir, 'concept-drops.jsonl'), line + '\n');
  } catch (error: unknown) {
    // stats are best-effort; never fail parsing over them
    logger.debug('PARSER', 'Failed to persist concept-drop stats', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function parseAgentXml(raw: string, correlationId?: string | number): ParseResult {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { valid: false };
  }

  raw = stripCodeFences(raw);

  const skipMatch = /<skip_summary(?:\s+reason="([^"]*)")?\s*\/>/.exec(raw);
  if (skipMatch) {
    return {
      valid: true,
      observations: [],
      summary: {
        request: null,
        investigated: null,
        learned: null,
        completed: null,
        next_steps: null,
        notes: null,
        skipped: true,
        skip_reason: skipMatch[1] ?? null,
      },
    };
  }

  const firstRoot = /<(observation|summary)\b/i.exec(raw);
  if (!firstRoot) {
    return { valid: false };
  }

  const rootName = firstRoot[1].toLowerCase();
  if (rootName === 'observation') {
    const observations = parseObservationBlocks(raw, correlationId);
    if (observations.length === 0) {
      return { valid: false };
    }
    return { valid: true, observations, summary: null };
  }

  const summary = parseSummaryBlock(raw, correlationId);
  if (!summary) {
    return { valid: false };
  }
  return { valid: true, observations: [], summary };
}

function parseObservationBlocks(text: string, correlationId?: string | number): ParsedObservation[] {
  const observations: ParsedObservation[] = [];

  const observationRegex = /<observation>([\s\S]*?)<\/observation>/g;

  let match;
  while ((match = observationRegex.exec(text)) !== null) {
    const obsContent = match[1];

    const type = extractField(obsContent, 'type');
    const title = extractField(obsContent, 'title');
    const subtitle = extractField(obsContent, 'subtitle');
    const narrative = extractField(obsContent, 'narrative');
    const facts = extractArrayElements(obsContent, 'facts', 'fact');
    const concepts = extractArrayElements(obsContent, 'concepts', 'concept');
    const files_read = extractArrayElements(obsContent, 'files_read', 'file');
    const files_modified = extractArrayElements(obsContent, 'files_modified', 'file');

    const mode = ModeManager.getInstance().getActiveMode();
    const validTypes = mode.observation_types.map(t => t.id);
    // fork: was validTypes[0], i.e. `bugfix` in the code mode — a missing <type> became a bug
    // fix. See FORK_NOTES "Observation type vocabulary".
    const fallbackType = validTypes.includes('change') ? 'change' : validTypes[0];
    let finalType = fallbackType;
    if (type) {
      finalType = type;
      if (!validTypes.includes(type)) {
        logger.error('PARSER', `Invalid observation type: ${type}, preserving emitted type`, { correlationId });
      }
    } else {
      logger.error('PARSER', `Observation missing type field, using "${fallbackType}"`, { correlationId });
    }

    // #3379: concepts are matched exactly by the injection SQL, so a prefixed
    // tag like "gotcha: WASM quirk" would never match. Truncate at the first
    // ':' and trim, then drop empties and the observation type.
    const cleanedConcepts = concepts
      .map(c => {
        const colonIndex = c.indexOf(':');
        return (colonIndex === -1 ? c : c.slice(0, colonIndex)).trim();
      })
      .filter(c => c !== '' && c !== finalType);

    if (cleanedConcepts.length !== concepts.length) {
      logger.debug('PARSER', 'Removed observation type from concepts array', {
        correlationId,
        type: finalType,
        originalConcepts: concepts,
        cleanedConcepts
      });
    }

    // FORK: vocabulary enforcement from the same mode object used for types —
    // one source of truth, applies to all parseAgentXml callers (worker +
    // server-beta). A mode without observation_concepts declares no vocabulary
    // and gets no filtering.
    const allowedConcepts = new Set((mode.observation_concepts ?? []).map(c => c.id));
    let finalConcepts = cleanedConcepts;
    if (allowedConcepts.size > 0) {
      const { kept, dropped } = filterConcepts(cleanedConcepts, allowedConcepts);
      finalConcepts = kept;
      if (dropped.length > 0) {
        recordConceptDrops(dropped, correlationId);
      }
    }

    if (!title && !narrative && facts.length === 0 && finalConcepts.length === 0) {
      logger.warn('PARSER', 'Skipping empty observation (all content fields null)', {
        correlationId,
        type: finalType
      });
      continue;
    }

    observations.push({
      type: finalType,
      title,
      subtitle,
      facts,
      narrative,
      concepts: finalConcepts,
      files_read,
      files_modified
    });
  }

  return observations;
}

function parseSummaryBlock(text: string, correlationId?: string | number): ParsedSummary | null {
  const summaryRegex = /<summary>([\s\S]*?)<\/summary>/;
  const summaryMatch = summaryRegex.exec(text);
  if (!summaryMatch) return null;

  const summaryContent = summaryMatch[1];

  const request = extractField(summaryContent, 'request');
  const investigated = extractField(summaryContent, 'investigated');
  const learned = extractField(summaryContent, 'learned');
  const completed = extractField(summaryContent, 'completed');
  const next_steps = extractField(summaryContent, 'next_steps');
  const notes = extractField(summaryContent, 'notes'); 

  if (!request && !investigated && !learned && !completed && !next_steps) {
    logger.warn('PARSER', 'Summary block has no sub-tags — rejecting false positive', { correlationId });
    return null;
  }

  return {
    request,
    investigated,
    learned,
    completed,
    next_steps,
    notes,
  };
}

function extractField(content: string, fieldName: string): string | null {
  const regex = new RegExp(`<${fieldName}>([\\s\\S]*?)</${fieldName}>`);
  const match = regex.exec(content);
  if (!match) return null;

  const trimmed = match[1].trim();
  return trimmed === '' ? null : trimmed;
}

function extractArrayElements(content: string, arrayName: string, elementName: string): string[] {
  const elements: string[] = [];

  const open = content.indexOf(`<${arrayName}>`);
  if (open === -1) {
    return elements;
  }

  const bodyStart = open + arrayName.length + 2;
  const rest = content.slice(bodyStart);

  // Fork: some models close the container with the singular element name
  // (`<concepts>` … `</concept>`), which used to drop every element in the block.
  // The elements themselves are well-formed, so when the container close is
  // missing, read up to the first tag that is neither the element nor its close.
  const closeAt = rest.indexOf(`</${arrayName}>`);
  const strayAt = new RegExp(`<(?!/?${elementName}>)[^>]*>`).exec(rest)?.index ?? -1;
  const end = closeAt !== -1 ? closeAt : strayAt !== -1 ? strayAt : rest.length;
  const arrayContent = rest.slice(0, end);

  const elementRegex = new RegExp(`<${elementName}>([\\s\\S]*?)</${elementName}>`, 'g');
  let elementMatch;
  while ((elementMatch = elementRegex.exec(arrayContent)) !== null) {
    const trimmed = elementMatch[1].trim();
    if (trimmed) {
      elements.push(trimmed);
    }
  }

  return elements;
}
