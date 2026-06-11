// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Server } from '../../src/services/server/Server.js';
import { ServerBetaViewerCompatRoutes } from '../../src/server/runtime/ServerBetaViewerCompatRoutes.js';
import { logger } from '../../src/utils/logger.js';

function fakePool() {
  const observations = [{
    id: 'obs-1',
    project_id: 'project-1',
    team_id: 'team-1',
    server_session_id: 'session-1',
    kind: 'manual',
    content: 'viewer compat observation',
    metadata: { title: 'Viewer Compat', concepts: ['viewer'], files_read: ['src/a.ts'] },
    created_at: new Date('2026-06-10T12:00:00.000Z'),
    updated_at: new Date('2026-06-10T12:01:00.000Z'),
    project_name: 'MKS',
    platform_source: 'claude-code',
  }];
  const prompts = [{
    id: 'prompt-1',
    content_session_id: 'content-1',
    project_name: 'MKS',
    platform_source: 'claude-code',
    prompt_number: 1,
    prompt_text: 'show viewer events',
    occurred_at: new Date('2026-06-10T11:59:00.000Z'),
  }];

  return {
    async query(sql: string) {
      if (sql.includes('AS observations') && sql.includes('AS sessions') && sql.includes('AS summaries')) {
        return { rows: [{ observations: 1, sessions: 1, summaries: 0, first_observation_at: observations[0].created_at }] };
      }
      if (sql.includes('SELECT DISTINCT')) {
        return { rows: [{ name: 'MKS', platform_source: 'claude-code' }] };
      }
      if (sql.includes('FROM observations o')) {
        return { rows: observations };
      }
      if (sql.includes('FROM agent_events e')) {
        return { rows: prompts };
      }
      if (sql.includes('FROM server_sessions')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

describe('ServerBetaViewerCompatRoutes', () => {
  let server: Server | null = null;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  afterEach(async () => {
    if (server?.getHttpServer()?.listening) {
      try { await server.close(); } catch { /* ignore */ }
    }
    loggerSpies.forEach(spy => spy.mockRestore());
    loggerSpies = [];
    server = null;
  });

  async function startServer(): Promise<number> {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
    ];
    server = new Server({
      getInitializationComplete: () => true,
      getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()),
      onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/server-beta.cjs',
      runtime: 'server-beta',
      getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    });
    server.registerRoutes(new ServerBetaViewerCompatRoutes({
      pool: fakePool() as never,
      port: 37877,
      startedAt: Date.now() - 1000,
    }));
    server.finalizeRoutes();
    const port = 43000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');
    const address = server.getHttpServer()?.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    return address.port;
  }

  it('serves the legacy viewer API endpoints from server-beta', async () => {
    const port = await startServer();

    const settings = await fetch(`http://127.0.0.1:${port}/api/settings`);
    expect(settings.status).toBe(200);

    const observations = await fetch(`http://127.0.0.1:${port}/api/observations?limit=20`);
    expect(observations.status).toBe(200);
    const observationsBody = await observations.json();
    expect(observationsBody.items[0].project).toBe('MKS');
    expect(observationsBody.items[0].narrative).toBe('viewer compat observation');
    expect(observationsBody.hasMore).toBe(false);

    const prompts = await fetch(`http://127.0.0.1:${port}/api/prompts?limit=20`);
    expect(prompts.status).toBe(200);
    const promptsBody = await prompts.json();
    expect(promptsBody.items[0].prompt_text).toBe('show viewer events');

    const promptSearch = await fetch(`http://127.0.0.1:${port}/api/search/prompts?limit=20`);
    expect(promptSearch.status).toBe(200);

    const stats = await fetch(`http://127.0.0.1:${port}/api/stats`);
    if (stats.status !== 200) {
      throw new Error(await stats.text());
    }
    expect(stats.status).toBe(200);
    const statsBody = await stats.json();
    expect(statsBody.worker.port).toBe(37877);
    expect(statsBody.database.observations).toBe(1);

    const processing = await fetch(`http://127.0.0.1:${port}/api/processing-status`);
    expect(processing.status).toBe(200);
    await expect(processing.json()).resolves.toEqual({ isProcessing: false, queueDepth: 0 });
  });

  it('opens /stream and sends initial_load plus processing_status events', async () => {
    const port = await startServer();
    const response = await fetch(`http://127.0.0.1:${port}/stream`, {
      signal: AbortSignal.timeout(1000),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const reader = response.body?.getReader();
    if (!reader) throw new Error('missing response body');
    let text = '';
    for (let i = 0; i < 4 && !text.includes('"type":"processing_status"'); i++) {
      const chunk = await reader.read();
      text += new TextDecoder().decode(chunk.value);
    }
    await reader.cancel();
    expect(text).toContain('"type":"connected"');
    expect(text).toContain('"type":"initial_load"');
    expect(text).toContain('"projects":["MKS"]');
    expect(text).toContain('"type":"processing_status"');
  });
});
