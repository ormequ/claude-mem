// SPDX-License-Identifier: Apache-2.0

import type { Application, Request, Response } from 'express';
import path from 'path';
import { existsSync, readFileSync, statSync } from 'fs';
import type { RouteHandler } from '../../services/server/Server.js';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import { getPackageRoot, paths, USER_SETTINGS_PATH } from '../../shared/paths.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { getUptimeSeconds } from '../../shared/uptime.js';
import { logger } from '../../utils/logger.js';

interface ServerBetaViewerCompatRoutesOptions {
  pool: PostgresPool;
  port: number;
  startedAt?: number;
}

interface ObservationViewerRow {
  id: string;
  project_id: string;
  team_id: string;
  server_session_id: string | null;
  kind: string;
  content: string;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
  project_name: string;
  platform_source: string | null;
}

interface PromptViewerRow {
  id: string;
  content_session_id: string | null;
  project_name: string;
  platform_source: string | null;
  prompt_number: number | null;
  prompt_text: string | null;
  occurred_at: Date;
}

interface SummaryViewerRow {
  id: string;
  content_session_id: string | null;
  project_name: string;
  platform_source: string | null;
  metadata: unknown;
  started_at: Date;
  ended_at: Date | null;
}

interface ProjectViewerRow {
  name: string;
  platform_source: string | null;
}

interface StatsViewerRow {
  observations: number;
  sessions: number;
  summaries: number;
  first_observation_at: Date | null;
}

export class ServerBetaViewerCompatRoutes implements RouteHandler {
  private readonly startedAt: number;
  private sseClientCount = 0;

  constructor(private readonly options: ServerBetaViewerCompatRoutesOptions) {
    this.startedAt = options.startedAt ?? Date.now();
  }

  setupRoutes(app: Application): void {
    app.get('/stream', this.handleStream);
    app.get('/api/settings', this.handleGetSettings);
    app.get('/api/observations', this.handleGetObservations);
    app.get('/api/summaries', this.handleGetSummaries);
    app.get('/api/prompts', this.handleGetPrompts);
    app.get('/api/search/prompts', this.handleGetPrompts);
    app.get('/api/stats', this.handleGetStats);
    app.get('/api/projects', this.handleGetProjects);
    app.get('/api/processing-status', this.handleGetProcessingStatus);
  }

  private handleStream = async (_req: Request, res: Response): Promise<void> => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    this.sseClientCount++;
    res.on('close', () => {
      this.sseClientCount = Math.max(0, this.sseClientCount - 1);
    });

    this.sendSse(res, { type: 'connected', timestamp: Date.now() });
    try {
      const catalog = await this.getProjectCatalog();
      this.sendSse(res, {
        type: 'initial_load',
        projects: catalog.projects,
        sources: catalog.sources,
        projectsBySource: catalog.projectsBySource,
        timestamp: Date.now(),
      });
    } catch (error) {
      logger.warn('HTTP', 'Failed to build server-beta viewer initial_load', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.sendSse(res, {
        type: 'initial_load',
        projects: [],
        sources: [],
        projectsBySource: {},
        timestamp: Date.now(),
      });
    }
    this.sendSse(res, { type: 'processing_status', isProcessing: false, queueDepth: 0, timestamp: Date.now() });
  };

  private handleGetSettings = (_req: Request, res: Response): void => {
    const settingsPath = paths.settings();
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath, false);
    res.json(settings);
  };

  private handleGetObservations = async (req: Request, res: Response): Promise<void> => {
    try {
      const { offset, limit, project } = this.parsePaginationParams(req);
      const rows = await this.listObservations({ offset, limit, project });
      res.json({
        items: rows.slice(0, limit).map(row => this.serializeObservation(row)),
        hasMore: rows.length > limit,
      });
    } catch (error) {
      this.handleError(res, error, 'Failed to load observations');
    }
  };

  private handleGetSummaries = async (req: Request, res: Response): Promise<void> => {
    try {
      const { offset, limit, project } = this.parsePaginationParams(req);
      const rows = await this.listSummaries({ offset, limit, project });
      res.json({
        items: rows.slice(0, limit).map(row => this.serializeSummary(row)),
        hasMore: rows.length > limit,
      });
    } catch (error) {
      this.handleError(res, error, 'Failed to load summaries');
    }
  };

  private handleGetPrompts = async (req: Request, res: Response): Promise<void> => {
    try {
      const { offset, limit, project } = this.parsePaginationParams(req);
      const rows = await this.listPrompts({ offset, limit, project });
      res.json({
        items: rows.slice(0, limit).map(row => this.serializePrompt(row)),
        hasMore: rows.length > limit,
      });
    } catch (error) {
      this.handleError(res, error, 'Failed to load prompts');
    }
  };

  private handleGetStats = async (_req: Request, res: Response): Promise<void> => {
    try {
      const version = this.readPackageVersion();
      const stats = await this.getStats();
      const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH, false) as unknown as Record<string, unknown>;
      const dbPath = String(settings.CLAUDE_MEM_SERVER_DATABASE_URL ?? settings.CLAUDE_MEM_DATABASE_URL ?? '');
      const dbSize = dbPath && existsSync(dbPath) ? statSync(dbPath).size : 0;

      res.json({
        worker: {
          version,
          uptime: getUptimeSeconds(this.startedAt),
          activeSessions: 0,
          sseClients: this.sseClientCount,
          port: this.options.port,
        },
        database: {
          path: dbPath,
          size: dbSize,
          observations: stats.observations,
          sessions: stats.sessions,
          summaries: stats.summaries,
          firstObservationAt: stats.first_observation_at?.toISOString() ?? null,
        },
      });
    } catch (error) {
      this.handleError(res, error, 'Failed to load stats');
    }
  };

  private handleGetProjects = async (_req: Request, res: Response): Promise<void> => {
    try {
      res.json(await this.getProjectCatalog());
    } catch (error) {
      this.handleError(res, error, 'Failed to load projects');
    }
  };

  private handleGetProcessingStatus = (_req: Request, res: Response): void => {
    res.json({ isProcessing: false, queueDepth: 0 });
  };

  private async listObservations(input: { offset: number; limit: number; project?: string }): Promise<ObservationViewerRow[]> {
    const result = await this.options.pool.query<ObservationViewerRow>(
      `
        SELECT
          o.id,
          o.project_id,
          o.team_id,
          o.server_session_id,
          o.kind,
          o.content,
          o.metadata,
          o.created_at,
          o.updated_at,
          p.name AS project_name,
          COALESCE(s.platform_source, 'claude-code') AS platform_source
        FROM observations o
        INNER JOIN projects p ON p.id = o.project_id AND p.team_id = o.team_id
        LEFT JOIN server_sessions s ON s.id = o.server_session_id
        WHERE ($1::text IS NULL OR p.name = $1 OR p.id = $1)
        ORDER BY o.created_at DESC
        OFFSET $2
        LIMIT $3
      `,
      [input.project ?? null, input.offset, input.limit + 1],
    );
    return result.rows;
  }

  private async listPrompts(input: { offset: number; limit: number; project?: string }): Promise<PromptViewerRow[]> {
    const result = await this.options.pool.query<PromptViewerRow>(
      `
        SELECT *
        FROM (
          SELECT
            s.id,
            s.content_session_id,
            p.name AS project_name,
            COALESCE(s.platform_source, 'claude-code') AS platform_source,
            1 AS prompt_number,
            s.metadata->>'prompt' AS prompt_text,
            s.started_at AS occurred_at
          FROM server_sessions s
          INNER JOIN projects p ON p.id = s.project_id AND p.team_id = s.team_id
          WHERE ($1::text IS NULL OR p.name = $1 OR p.id = $1)
            AND NULLIF(s.metadata->>'prompt', '') IS NOT NULL

          UNION ALL

          SELECT
            e.id,
            s.content_session_id,
            p.name AS project_name,
            COALESCE(e.platform_source, s.platform_source, 'claude-code') AS platform_source,
            COALESCE((e.payload->>'promptNumber')::int, (e.payload->>'prompt_number')::int) AS prompt_number,
            COALESCE(e.payload->>'prompt', e.payload->>'user_prompt', e.payload->>'text') AS prompt_text,
            e.occurred_at
          FROM agent_events e
          INNER JOIN projects p ON p.id = e.project_id AND p.team_id = e.team_id
          LEFT JOIN server_sessions s ON s.id = e.server_session_id
          WHERE ($1::text IS NULL OR p.name = $1 OR p.id = $1)
            AND (
              e.event_type IN ('user_prompt', 'prompt', 'session_start')
              OR e.payload ? 'prompt'
              OR e.payload ? 'user_prompt'
            )
        ) prompts
        ORDER BY occurred_at DESC
        OFFSET $2
        LIMIT $3
      `,
      [input.project ?? null, input.offset, input.limit + 1],
    );
    return result.rows;
  }

  private async listSummaries(input: { offset: number; limit: number; project?: string }): Promise<SummaryViewerRow[]> {
    const result = await this.options.pool.query<SummaryViewerRow>(
      `
        SELECT
          s.id,
          s.content_session_id,
          p.name AS project_name,
          COALESCE(s.platform_source, 'claude-code') AS platform_source,
          s.metadata,
          s.started_at,
          s.ended_at
        FROM server_sessions s
        INNER JOIN projects p ON p.id = s.project_id AND p.team_id = s.team_id
        WHERE ($1::text IS NULL OR p.name = $1 OR p.id = $1)
          AND s.ended_at IS NOT NULL
        ORDER BY COALESCE(s.ended_at, s.started_at) DESC
        OFFSET $2
        LIMIT $3
      `,
      [input.project ?? null, input.offset, input.limit + 1],
    );
    return result.rows;
  }

  private async getProjectCatalog(): Promise<{ projects: string[]; sources: string[]; projectsBySource: Record<string, string[]> }> {
    const result = await this.options.pool.query<ProjectViewerRow>(
      `
        SELECT DISTINCT
          p.name,
          COALESCE(s.platform_source, e.platform_source, 'claude-code') AS platform_source
        FROM projects p
        LEFT JOIN server_sessions s ON s.project_id = p.id AND s.team_id = p.team_id
        LEFT JOIN agent_events e ON e.project_id = p.id AND e.team_id = p.team_id
        ORDER BY p.name ASC
      `,
    );
    const projects = Array.from(new Set(result.rows.map(row => row.name).filter(Boolean))).sort();
    const sources = Array.from(new Set(result.rows.map(row => row.platform_source ?? 'claude-code'))).sort();
    const projectsBySource: Record<string, string[]> = {};
    for (const source of sources) {
      projectsBySource[source] = Array.from(new Set(
        result.rows
          .filter(row => (row.platform_source ?? 'claude-code') === source)
          .map(row => row.name)
          .filter(Boolean),
      )).sort();
    }
    return { projects, sources, projectsBySource };
  }

  private async getStats(): Promise<StatsViewerRow> {
    const result = await this.options.pool.query<StatsViewerRow>(
      `
        SELECT
          (SELECT COUNT(*)::int FROM observations) AS observations,
          (SELECT COUNT(*)::int FROM server_sessions) AS sessions,
          (SELECT COUNT(*)::int FROM server_sessions WHERE ended_at IS NOT NULL) AS summaries,
          (SELECT MIN(created_at) FROM observations) AS first_observation_at
      `,
    );
    return result.rows[0] ?? { observations: 0, sessions: 0, summaries: 0, first_observation_at: null };
  }

  private serializeObservation(row: ObservationViewerRow): Record<string, unknown> {
    const metadata = asRecord(row.metadata);
    return {
      id: row.id,
      memory_session_id: row.server_session_id ?? row.id,
      project: row.project_name,
      merged_into_project: null,
      platform_source: row.platform_source ?? 'claude-code',
      type: row.kind,
      title: stringOrNull(metadata.title) ?? row.kind,
      subtitle: stringOrNull(metadata.subtitle),
      narrative: row.content,
      text: row.content,
      facts: stringifyJsonField(metadata.facts),
      concepts: stringifyJsonField(metadata.concepts),
      files_read: stringifyJsonField(metadata.files_read ?? metadata.filesRead),
      files_modified: stringifyJsonField(metadata.files_modified ?? metadata.filesModified),
      prompt_number: numberOrNull(metadata.prompt_number ?? metadata.promptNumber),
      created_at: row.created_at.toISOString(),
      created_at_epoch: row.created_at.getTime(),
    };
  }

  private serializePrompt(row: PromptViewerRow): Record<string, unknown> {
    return {
      id: row.id,
      content_session_id: row.content_session_id ?? row.id,
      project: row.project_name,
      platform_source: row.platform_source ?? 'claude-code',
      prompt_number: row.prompt_number ?? 1,
      prompt_text: row.prompt_text ?? '',
      created_at_epoch: row.occurred_at.getTime(),
    };
  }

  private serializeSummary(row: SummaryViewerRow): Record<string, unknown> {
    const metadata = asRecord(row.metadata);
    const createdAt = row.ended_at ?? row.started_at;
    return {
      id: row.id,
      session_id: row.content_session_id ?? row.id,
      project: row.project_name,
      platform_source: row.platform_source ?? 'claude-code',
      request: stringOrNull(metadata.request),
      investigated: stringOrNull(metadata.investigated),
      learned: stringOrNull(metadata.learned),
      completed: stringOrNull(metadata.completed),
      next_steps: stringOrNull(metadata.next_steps ?? metadata.nextSteps),
      created_at_epoch: createdAt.getTime(),
    };
  }

  private parsePaginationParams(req: Request): { offset: number; limit: number; project?: string } {
    return {
      offset: clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
      limit: clampInt(req.query.limit, 20, 1, 100),
      project: typeof req.query.project === 'string' && req.query.project.length > 0
        ? req.query.project
        : undefined,
    };
  }

  private sendSse(res: Response, event: Record<string, unknown>): void {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  private handleError(res: Response, error: unknown, message: string): void {
    logger.warn('HTTP', message, {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'ServerBetaViewerCompatError', message });
  }

  private readPackageVersion(): string {
    for (const candidate of [path.join(getPackageRoot(), 'package.json'), path.join(process.cwd(), 'package.json')]) {
      try {
        if (!existsSync(candidate)) continue;
        return JSON.parse(readFileSync(candidate, 'utf-8')).version ?? 'development';
      } catch {
        continue;
      }
    }
    return 'development';
  }
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = typeof raw === 'string' || typeof raw === 'number'
    ? Number.parseInt(String(raw), 10)
    : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function stringifyJsonField(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}
