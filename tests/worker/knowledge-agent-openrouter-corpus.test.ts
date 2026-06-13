import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    throw new Error('Claude SDK should not be used when CLAUDE_MEM_PROVIDER=openrouter');
  },
}));

import { KnowledgeAgent } from '../../src/services/worker/knowledge/KnowledgeAgent.js';
import type { CorpusFile } from '../../src/services/worker/knowledge/types.js';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function corpusFixture(): CorpusFile {
  return {
    version: 1,
    name: 'mks-smoke-test',
    description: 'smoke corpus',
    created_at: '2026-06-10T00:00:00.000Z',
    updated_at: '2026-06-10T00:00:00.000Z',
    filter: {},
    stats: {
      observation_count: 1,
      token_estimate: 100,
      date_range: { earliest: '2026-06-10', latest: '2026-06-10' },
      type_breakdown: { decision: 1 },
    },
    system_prompt: 'Answer from corpus only.',
    session_id: null,
    observations: [{
      id: 1,
      memory_session_id: 'm1',
      project: 'mks',
      type: 'decision',
      title: 'MKS marker',
      subtitle: '',
      narrative: 'mks-smoke-test covers grpcutil.',
      facts: [],
      concepts: [],
      files_read: [],
      files_modified: [],
      created_at: '2026-06-10T00:00:00.000Z',
      created_at_epoch: Date.parse('2026-06-10T00:00:00.000Z'),
    }],
  };
}

describe('KnowledgeAgent OpenRouter corpus mode', () => {
  beforeEach(() => {
    process.env.CLAUDE_MEM_PROVIDER = 'openrouter';
    process.env.CLAUDE_MEM_OPENROUTER_API_KEY = 'test-key';
    process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = 'https://ai.selectel.org/api';
    process.env.CLAUDE_MEM_OPENROUTER_MODEL = 'minimax-m2.7';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it('primes and queries through OpenRouter-compatible chat completions without Claude SDK resume', async () => {
    const requests: Array<{ url: string; body: any }> = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'корпус содержит mks-smoke-test' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as any;

    const writes: CorpusFile[] = [];
    const corpus = corpusFixture();
    const agent = new KnowledgeAgent({
      read: () => corpus,
      write: (updated: CorpusFile) => {
        writes.push({ ...updated });
      },
    } as any);

    const sessionId = await agent.prime(corpus);
    const result = await agent.query(corpus, 'Что внутри корпуса?');

    expect(sessionId).toStartWith('openrouter-corpus-mks-smoke-test-');
    expect(result.answer).toContain('mks-smoke-test');
    expect(result.session_id).toBe(sessionId);
    expect(requests.map((request) => request.url)).toEqual([
      'https://ai.selectel.org/api/chat/completions',
      'https://ai.selectel.org/api/chat/completions',
    ]);
    expect(requests[1].body.messages.at(-1)).toEqual({
      role: 'user',
      content: 'Что внутри корпуса?',
    });
    expect(writes.at(-1)?.session_id).toBe(sessionId);
  });

  it('returns an existing corpus session without re-priming', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('prime should not call OpenRouter when session_id already exists');
    }) as any;

    const corpus = corpusFixture();
    corpus.session_id = 'openrouter-corpus-mks-smoke-test-existing';
    const agent = new KnowledgeAgent({
      write: () => {
        throw new Error('prime should not rewrite an already primed corpus');
      },
    } as any);

    const sessionId = await agent.prime(corpus);

    expect(sessionId).toBe('openrouter-corpus-mks-smoke-test-existing');
  });
});
