#!/usr/bin/env bun

import { Database } from 'bun:sqlite';
import { Client } from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { computeObservationContentHash } from '../src/services/sqlite/observations/store.js';

type ServerBetaObservation = {
  id: string;
  project_id: string | null;
  project_name: string | null;
  server_session_id: string | null;
  content_session_id: string | null;
  external_session_id: string | null;
  platform_source: string | null;
  agent_type: string | null;
  agent_id: string | null;
  session_started_at: Date | string | null;
  session_ended_at: Date | string | null;
  kind: string | null;
  content: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date | string;
};

function readSettings(): Record<string, string> {
  const settingsPath = join(homedir(), '.claude-mem', 'settings.json');
  return JSON.parse(readFileSync(settingsPath, 'utf8'));
}

function asIso(value: Date | string | null | undefined, fallbackEpoch: number): string {
  if (!value) return new Date(fallbackEpoch).toISOString();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(fallbackEpoch).toISOString() : date.toISOString();
}

function asEpoch(value: Date | string | null | undefined, fallbackEpoch: number): number {
  if (!value) return fallbackEpoch;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? fallbackEpoch : date.getTime();
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function firstNonEmpty(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function inferTitle(content: string | null): string | null {
  if (!content) return null;
  return content.split('\n').find((line) => line.trim())?.trim() ?? null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const settings = readSettings();
  const databaseUrl = settings.CLAUDE_MEM_SERVER_DATABASE_URL;
  if (!databaseUrl) throw new Error('CLAUDE_MEM_SERVER_DATABASE_URL is not set in ~/.claude-mem/settings.json');

  const sqlitePath = join(homedir(), '.claude-mem', 'claude-mem.db');
  if (!existsSync(sqlitePath)) throw new Error(`Worker SQLite DB not found: ${sqlitePath}`);

  const pg = new Client({ connectionString: databaseUrl });
  await pg.connect();

  const result = await pg.query<ServerBetaObservation>(`
    SELECT
      o.id,
      o.project_id,
      p.name AS project_name,
      o.server_session_id,
      ss.content_session_id,
      ss.external_session_id,
      ss.platform_source,
      ss.agent_type,
      ss.agent_id,
      ss.started_at AS session_started_at,
      ss.ended_at AS session_ended_at,
      o.kind,
      o.content,
      o.metadata,
      o.created_at
    FROM observations o
    LEFT JOIN projects p ON p.id = o.project_id
    LEFT JOIN server_sessions ss ON ss.id = o.server_session_id
    ORDER BY o.created_at ASC, o.id ASC
  `);
  await pg.end();

  const sqlite = new Database(sqlitePath);
  sqlite.exec('PRAGMA foreign_keys = ON');

  const existingByContent = sqlite.prepare(`
    SELECT id FROM observations
    WHERE project = ?
      AND type = ?
      AND COALESCE(title, '') = COALESCE(?, '')
      AND COALESCE(narrative, '') = COALESCE(?, '')
    LIMIT 1
  `);

  const insertSession = sqlite.prepare(`
    INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch,
       completed_at, completed_at_epoch, status, prompt_counter)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(memory_session_id) DO NOTHING
  `);

  const insertObservation = sqlite.prepare(`
    INSERT INTO observations
      (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id,
       content_hash, created_at, created_at_epoch, generated_by_model, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(memory_session_id, content_hash) DO NOTHING
  `);

  let insertedSessions = 0;
  let insertedObservations = 0;
  let skippedDuplicates = 0;

  const tx = sqlite.transaction((rows: ServerBetaObservation[]) => {
    const seenSessions = new Set<string>();

    for (const row of rows) {
      const metadata = row.metadata ?? {};
      const project = firstNonEmpty(row.project_name, row.project_id, 'server-beta')!;
      const serverSessionId = firstNonEmpty(row.server_session_id, row.content_session_id, row.external_session_id, row.id)!;
      const memorySessionId = `server-beta-${serverSessionId}`;
      const contentSessionId = `server-beta-${firstNonEmpty(row.content_session_id, row.external_session_id, row.server_session_id, row.id)}`;
      const createdAtEpoch = asEpoch(row.created_at, Date.now());
      const createdAtIso = asIso(row.created_at, createdAtEpoch);
      const startedAtEpoch = asEpoch(row.session_started_at, createdAtEpoch);
      const startedAtIso = asIso(row.session_started_at, startedAtEpoch);
      const completedAtEpoch = row.session_ended_at ? asEpoch(row.session_ended_at, createdAtEpoch) : null;
      const completedAtIso = row.session_ended_at ? asIso(row.session_ended_at, createdAtEpoch) : null;

      const type = firstNonEmpty(row.kind, 'other')!;
      const title = firstNonEmpty(metadata.title, inferTitle(row.content));
      const subtitle = firstNonEmpty(metadata.subtitle);
      const narrative = firstNonEmpty(metadata.narrative, row.content);
      const facts = asStringArray(metadata.facts);
      const concepts = asStringArray(metadata.concepts);
      const filesRead = asStringArray(metadata.files_read);
      const filesModified = asStringArray(metadata.files_modified);
      const generatedByModel = firstNonEmpty(metadata.model);

      if (existingByContent.get(project, type, title, narrative)) {
        skippedDuplicates++;
        continue;
      }

      if (!seenSessions.has(memorySessionId)) {
        const sessionResult = insertSession.run(
          contentSessionId,
          memorySessionId,
          project,
          firstNonEmpty(row.platform_source, 'claude')!,
          startedAtIso,
          startedAtEpoch,
          completedAtIso,
          completedAtEpoch,
          completedAtIso ? 'completed' : 'active',
        );
        if (sessionResult.changes > 0) insertedSessions++;
        seenSessions.add(memorySessionId);
      }

      const contentHash = computeObservationContentHash(memorySessionId, title, narrative);
      const observationResult = insertObservation.run(
        memorySessionId,
        project,
        type,
        title,
        subtitle,
        JSON.stringify(facts),
        narrative,
        JSON.stringify(concepts),
        JSON.stringify(filesRead),
        JSON.stringify(filesModified),
        null,
        0,
        row.agent_type,
        row.agent_id,
        contentHash,
        createdAtIso,
        createdAtEpoch,
        generatedByModel,
        JSON.stringify({ ...metadata, server_beta_observation_id: row.id, server_beta_project_id: row.project_id }),
      );
      if (observationResult.changes > 0) insertedObservations++;
    }
  });

  if (apply) {
    tx(result.rows);
  } else {
    sqlite.exec('BEGIN');
    try {
      tx(result.rows);
    } finally {
      sqlite.exec('ROLLBACK');
    }
  }

  sqlite.close();

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    sourceObservations: result.rowCount,
    insertedSessions,
    insertedObservations,
    skippedDuplicates,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
