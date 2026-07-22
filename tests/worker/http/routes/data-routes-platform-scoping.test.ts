import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

type Method = 'get' | 'post';

function captureRoute(routes: DataRoutes, method: Method, targetPath: string): (req: Request, res: Response) => void {
  let middleware: ((req: Request, res: Response, next: () => void) => void) | undefined;
  let handler: ((req: Request, res: Response) => void) | undefined;
  const register = mock((path: string, ...rest: any[]) => {
    if (path !== targetPath) return;
    if (rest.length === 1) {
      handler = rest[0];
    } else {
      middleware = rest[0];
      handler = rest[1];
    }
  });
  const app = {
    get: method === 'get' ? register : mock(() => {}),
    post: method === 'post' ? register : mock(() => {}),
  };

  routes.setupRoutes(app as any);
  if (!handler) throw new Error(`Handler not registered for ${method.toUpperCase()} ${targetPath}`);

  return (req: Request, res: Response): void => {
    if (!middleware) {
      handler!(req, res);
      return;
    }
    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });
    if (nextCalled) handler!(req, res);
  };
}

function makeResponse(): { res: Response; json: ReturnType<typeof mock>; status: ReturnType<typeof mock> } {
  const json = mock(() => {});
  const res = {
    headersSent: false,
    json,
    status: mock((code: number) => {
      (res as any).statusCode = code;
      return res;
    }),
  } as any;
  return { res: res as Response, json, status: res.status };
}

function makeRequest(input: {
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  headers?: Record<string, string>;
}): Request {
  const headers = Object.fromEntries(
    Object.entries(input.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    path: '/test',
    body: input.body ?? {},
    query: input.query ?? {},
    params: input.params ?? {},
    get: (name: string) => headers[name.toLowerCase()],
  } as any;
}

function insertPrompt(
  store: SessionStore,
  sessionDbId: number,
  contentSessionId: string,
  promptText: string,
  createdAtEpoch: number
): number {
  const result = store.db.prepare(`
    INSERT INTO user_prompts
    (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sessionDbId, contentSessionId, 1, promptText, new Date(createdAtEpoch).toISOString(), createdAtEpoch);
  return Number(result.lastInsertRowid);
}

describe('DataRoutes cross-harness hydration (platform_source ignored on reads)', () => {
  let store: SessionStore;
  let routes: DataRoutes;
  const project = 'data-route-platform-scope';
  const contentSessionId = 'shared-data-route-raw-id';
  const filePath = 'src/shared-platform-file.ts';

  beforeEach(() => {
    store = new SessionStore(':memory:');
    routes = new DataRoutes(
      {} as any,
      { getSessionStore: () => store, getChromaSync: () => null } as any,
      {} as any,
      {} as any,
      {} as any,
      Date.now(),
    );
  });

  afterEach(() => {
    store.close();
  });

  function seedPlatformRows(): {
    claudeObservationId: number;
    cursorObservationId: number;
    claudeSummaryId: number;
    claudePromptId: number;
  } {
    const baseEpoch = Date.UTC(2024, 2, 1, 0, 0, 0);
    const claudeSessionDbId = store.createSDKSession(contentSessionId, project, 'claude prompt', undefined, 'claude');
    store.ensureMemorySessionIdRegistered(claudeSessionDbId, 'claude-data-route-memory');
    const cursorSessionDbId = store.createSDKSession(contentSessionId, project, 'cursor prompt', undefined, 'cursor');
    store.ensureMemorySessionIdRegistered(cursorSessionDbId, 'cursor-data-route-memory');

    const claudeObservation = store.storeObservation(
      'claude-data-route-memory',
      project,
      {
        type: 'discovery',
        title: 'CLAUDE_ROUTE_OBS',
        subtitle: null,
        facts: [],
        narrative: 'claude route observation',
        concepts: [],
        files_read: [filePath],
        files_modified: [],
      },
      1,
      0,
      baseEpoch
    );
    const cursorObservation = store.storeObservation(
      'cursor-data-route-memory',
      project,
      {
        type: 'discovery',
        title: 'CURSOR_ROUTE_OBS',
        subtitle: null,
        facts: [],
        narrative: 'cursor route observation',
        concepts: [],
        files_read: [filePath],
        files_modified: [],
      },
      1,
      0,
      baseEpoch + 1_000
    );
    const claudeSummary = store.storeSummary(
      'claude-data-route-memory',
      project,
      {
        request: 'CLAUDE_ROUTE_SUMMARY',
        investigated: '',
        learned: '',
        completed: '',
        next_steps: '',
        notes: null,
      },
      1,
      0,
      baseEpoch
    );
    store.storeSummary(
      'cursor-data-route-memory',
      project,
      {
        request: 'CURSOR_ROUTE_SUMMARY',
        investigated: '',
        learned: '',
        completed: '',
        next_steps: '',
        notes: null,
      },
      1,
      0,
      baseEpoch + 1_000
    );
    const claudePromptId = insertPrompt(store, claudeSessionDbId, contentSessionId, 'CLAUDE_ROUTE_PROMPT', baseEpoch);
    insertPrompt(store, cursorSessionDbId, contentSessionId, 'CURSOR_ROUTE_PROMPT', baseEpoch + 1_000);

    return {
      claudeObservationId: claudeObservation.id,
      cursorObservationId: cursorObservation.id,
      claudeSummaryId: claudeSummary.id,
      claudePromptId,
    };
  }

  it('hydrates batch, session, prompt, and by-file cross-harness even when a platform is requested', () => {
    const ids = seedPlatformRows();

    // Batch hydration: requesting platform_source=cursor still returns BOTH the
    // claude- and cursor-sourced rows — ids come from cross-harness search, so
    // the fetch must not re-scope (else the claude id would silently drop).
    const batchHandler = captureRoute(routes, 'post', '/api/observations/batch');
    const batchResponse = makeResponse();
    batchHandler(makeRequest({
      body: {
        ids: [ids.claudeObservationId, ids.cursorObservationId],
        platform_source: 'cursor',
      },
    }), batchResponse.res);
    const batchArg = batchResponse.json.mock.calls[0][0] as any[];
    expect(batchArg).toHaveLength(2);
    expect(batchArg).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: ids.claudeObservationId, title: 'CLAUDE_ROUTE_OBS' }),
      expect.objectContaining({ id: ids.cursorObservationId, title: 'CURSOR_ROUTE_OBS' }),
    ]));

    // Cross-platform single-summary lookup now succeeds instead of 404.
    const sessionHandler = captureRoute(routes, 'get', '/api/session/:id');
    const sessionResponse = makeResponse();
    sessionHandler(makeRequest({
      params: { id: String(ids.claudeSummaryId) },
      query: { platformSource: 'cursor' },
    }), sessionResponse.res);
    expect(sessionResponse.status).not.toHaveBeenCalledWith(404);
    expect(sessionResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({ id: ids.claudeSummaryId, request: 'CLAUDE_ROUTE_SUMMARY' })
    );

    // Cross-platform single-prompt lookup now succeeds instead of 404.
    const promptHandler = captureRoute(routes, 'get', '/api/prompt/:id');
    const promptResponse = makeResponse();
    promptHandler(makeRequest({
      params: { id: String(ids.claudePromptId) },
      query: { platform_source: 'cursor' },
    }), promptResponse.res);
    expect(promptResponse.status).not.toHaveBeenCalledWith(404);
    expect(promptResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({ prompt_text: 'CLAUDE_ROUTE_PROMPT' })
    );

    // by-file Read hint: surfaces observations from every harness for the file.
    const byFileHandler = captureRoute(routes, 'get', '/api/observations/by-file');
    const byFileResponse = makeResponse();
    byFileHandler(makeRequest({
      query: { path: filePath, projects: project },
      headers: { 'x-platform-source': 'cursor' },
    }), byFileResponse.res);
    const byFileArg = byFileResponse.json.mock.calls[0][0] as { observations: any[]; count: number };
    expect(byFileArg.count).toBe(2);
    expect(byFileArg.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: ids.claudeObservationId, title: 'CLAUDE_ROUTE_OBS' }),
      expect.objectContaining({ id: ids.cursorObservationId, title: 'CURSOR_ROUTE_OBS' }),
    ]));
  });

  it('hydrates a single observation cross-harness regardless of requested platform', () => {
    const ids = seedPlatformRows();
    const handler = captureRoute(routes, 'get', '/api/observation/:id');

    // A claude-sourced id fetched with platformSource=cursor now hydrates
    // (previously 404) — this is what makes cross-harness search results usable.
    const mismatchResponse = makeResponse();
    handler(makeRequest({
      params: { id: String(ids.claudeObservationId) },
      query: { platformSource: 'cursor' },
    }), mismatchResponse.res);
    expect(mismatchResponse.status).not.toHaveBeenCalledWith(404);
    expect(mismatchResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({ id: ids.claudeObservationId, title: 'CLAUDE_ROUTE_OBS' })
    );

    const matchResponse = makeResponse();
    handler(makeRequest({
      params: { id: String(ids.cursorObservationId) },
      headers: { 'x-claude-mem-platform-source': 'cursor' },
    }), matchResponse.res);
    expect(matchResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({ id: ids.cursorObservationId, title: 'CURSOR_ROUTE_OBS' })
    );
  });
});
