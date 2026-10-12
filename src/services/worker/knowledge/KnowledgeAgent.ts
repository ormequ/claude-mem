
import { CorpusStore } from './CorpusStore.js';
import { CorpusRenderer } from './CorpusRenderer.js';
import type { CorpusFile, QueryResult } from './types.js';
import { logger } from '../../../utils/logger.js';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../shared/paths.js';
import { buildIsolatedEnvWithFreshOAuth } from '../../../shared/EnvManager.js';
import { findClaudeExecutable } from '../../../shared/find-claude-executable.js';
import { sanitizeEnv } from '../../../supervisor/env-sanitizer.js';
import { resolveTierAlias, resolveOpenRouterQaModel } from '../model-aliases.js';
import { resolveOpenRouterChatCompletionsUrl } from '../../../shared/openrouter-base-url.js';

import { buildHardenedSdkOptions } from '../../../sdk/hardened-options.js';

type ClaudeAgentSdk = {
  query: (input: {
    prompt: string;
    options: ReturnType<typeof buildHardenedSdkOptions>;
  }) => AsyncIterable<any>;
};

async function loadClaudeAgentSdk(): Promise<ClaudeAgentSdk> {
  // @ts-ignore - Agent SDK types may not be available
  return await import('@anthropic-ai/claude-agent-sdk');
}

/**
 * The exact line the Claude Code CLI prints when `--resume <id>` names a
 * session it has no transcript for. In stream-json mode it arrives first as the
 * `errors` entry of an `error_during_execution` result, which
 * `errorFromUnsuccessfulResult` keeps in its message; the Agent SDK can also
 * repeat it inside `Claude Code process exited with code N. stderr: <tail>`
 * (sdk.mjs `formatStderrTail`). The line itself lives in the CLI binary
 * (@anthropic-ai/claude-agent-sdk-darwin-arm64/claude, SDK 0.3.289).
 */
const SDK_SESSION_RESUME_FAILURE_PATTERN = /No conversation found with session ID/;

/**
 * True only for the SDK's explicit "this session cannot be resumed" failure.
 * Anything else (auth, network, a generic "not found", an abort) must surface
 * as-is rather than silently paying for a fresh prime.
 */
export function isSessionResumeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return SDK_SESSION_RESUME_FAILURE_PATTERN.test(message);
}

/**
 * The error for a terminal SDK result that did not succeed, carrying the
 * result's own text: `errors` on the error subtypes, `result` on an `is_error`
 * success (an API error). The SDK builds its "Claude Code returned an error
 * result" error the same way (sdk.mjs). Keeping that text is what lets
 * `isSessionResumeError` see an expired session, so `query` still reprimes.
 */
function errorFromUnsuccessfulResult(
  action: 'prime' | 'query',
  resultMessage: { subtype?: string; result?: unknown; errors?: unknown }
): Error {
  const details = resultMessage.subtype === 'success'
    ? (typeof resultMessage.result === 'string' ? resultMessage.result.trim() : '')
    : (Array.isArray(resultMessage.errors)
      ? resultMessage.errors.map((entry) => String(entry).trim()).filter(Boolean).join('; ')
      : '');
  return new Error(`Knowledge ${action} failed (${resultMessage.subtype})${details ? `: ${details}` : ''}`);
}

/** Fork: where corpus Q&A goes when an HTTP provider is selected (chatCompletionsEndpoint). */
interface ChatCompletionsEndpoint {
  apiUrl: string;
  model: string;
  headers: Record<string, string>;
}

/** Per-call options. `abortController` is passed to the Agent SDK's `Options.abortController` (sdk.d.ts). */
export interface KnowledgeAgentCallOptions {
  abortController?: AbortController;
}

export class KnowledgeAgent {
  private renderer: CorpusRenderer;

  constructor(
    private corpusStore: CorpusStore
  ) {
    this.renderer = new CorpusRenderer();
  }

  async prime(corpus: CorpusFile, callOptions: KnowledgeAgentCallOptions = {}): Promise<string> {
    const endpoint = await this.chatCompletionsEndpoint();
    if (endpoint) {
      // No Claude session to expire here, so an existing one stays valid.
      if (corpus.session_id) {
        logger.info('WORKER', `Knowledge agent already primed for corpus "${corpus.name}"`);
        return corpus.session_id;
      }
      await this.queryChatCompletionsCorpus(endpoint, corpus, [
        corpus.system_prompt,
        '',
        'Here is your complete knowledge base:',
        '',
        this.renderer.renderCorpus(corpus),
        '',
        'Acknowledge what you have received. Summarize the key themes and topics you can answer questions about.'
      ].join('\n'), callOptions.abortController?.signal);
      const sessionId = `openrouter-corpus-${corpus.name}-${Date.now()}`;
      corpus.session_id = sessionId;
      this.corpusStore.write(corpus);
      logger.info('WORKER', `Knowledge agent primed for corpus "${corpus.name}" via OpenAI-compatible chat completions`);
      return sessionId;
    }

    const renderedCorpus = this.renderer.renderCorpus(corpus);

    const primePrompt = [
      corpus.system_prompt,
      '',
      'Here is your complete knowledge base:',
      '',
      renderedCorpus,
      '',
      'Acknowledge what you\'ve received. Summarize the key themes and topics you can answer questions about.'
    ].join('\n');

    const claudePath = findClaudeExecutable('WORKER');
    const isolatedEnv = sanitizeEnv(await buildIsolatedEnvWithFreshOAuth());

    const { query } = await loadClaudeAgentSdk();
    const queryResult = query({
      prompt: primePrompt,
      options: buildHardenedSdkOptions({
        source: 'KnowledgeAgent',
        project: corpus.name,
        model: this.getModelId(),
        env: isolatedEnv,
        pathToClaudeCodeExecutable: claudePath,
        abortController: callOptions.abortController,
      }),
    });

    let sessionId: string | undefined;
    let successfulResult = false;
    try {
      for await (const msg of queryResult) {
        if (msg.session_id) sessionId = msg.session_id;
        if (msg.type === 'result') {
          successfulResult = msg.is_error !== true && msg.subtype === 'success';
          if (!successfulResult) throw errorFromUnsuccessfulResult('prime', msg);
          logger.info('WORKER', `Knowledge agent primed for corpus "${corpus.name}"`);
        }
      }
    } catch (error) {
      if (callOptions.abortController?.signal.aborted) throw error;
      if (sessionId && successfulResult) {
        if (error instanceof Error) {
          logger.debug('WORKER', `SDK process exited after priming corpus "${corpus.name}" — session captured, continuing`, {}, error);
        } else {
          logger.debug('WORKER', `SDK process exited after priming corpus "${corpus.name}" — session captured, continuing (non-Error thrown)`, { thrownValue: String(error) });
        }
      } else {
        throw error;
      }
    }

    // Never persist a session whose prime the caller abandoned, even if the SDK ended quietly.
    callOptions.abortController?.signal.throwIfAborted();

    if (!successfulResult) {
      throw new Error(`Knowledge prime ended without a successful result for corpus "${corpus.name}"`);
    }
    if (!sessionId) {
      throw new Error(`Failed to capture session_id while priming corpus "${corpus.name}"`);
    }

    corpus.session_id = sessionId;
    this.corpusStore.write(corpus);

    return sessionId;
  }

  async query(corpus: CorpusFile, question: string, callOptions: KnowledgeAgentCallOptions = {}): Promise<QueryResult> {
    if (!corpus.session_id) {
      throw new Error(`Corpus "${corpus.name}" has no session — call prime first`);
    }

    const endpoint = await this.chatCompletionsEndpoint();
    if (endpoint) {
      const result = await this.queryChatCompletionsCorpus(endpoint, corpus, question, callOptions.abortController?.signal);
      return { answer: result.answer, session_id: corpus.session_id };
    }

    try {
      const result = await this.executeQuery(corpus, question, callOptions);
      if (result.session_id !== corpus.session_id) {
        corpus.session_id = result.session_id;
        this.corpusStore.write(corpus);
      }
      return result;
    } catch (error) {
      // The caller walked away; the route logs that once. Not a query failure.
      if (callOptions.abortController?.signal.aborted) throw error;
      if (!isSessionResumeError(error)) {
        if (error instanceof Error) {
          logger.error('WORKER', `Query failed for corpus "${corpus.name}"`, {}, error);
        } else {
          logger.error('WORKER', `Query failed for corpus "${corpus.name}" (non-Error thrown)`, { thrownValue: String(error) });
        }
        throw error;
      }
      logger.info('WORKER', `Session expired for corpus "${corpus.name}", auto-repriming...`);
      await this.prime(corpus, callOptions);
      const refreshedCorpus = this.corpusStore.read(corpus.name);
      if (!refreshedCorpus || !refreshedCorpus.session_id) {
        throw new Error(`Auto-reprime failed for corpus "${corpus.name}"`);
      }
      const result = await this.executeQuery(refreshedCorpus, question, callOptions);
      if (result.session_id !== refreshedCorpus.session_id) {
        refreshedCorpus.session_id = result.session_id;
        this.corpusStore.write(refreshedCorpus);
      }
      return result;
    }
  }

  async reprime(corpus: CorpusFile, callOptions: KnowledgeAgentCallOptions = {}): Promise<string> {
    corpus.session_id = null;
    return this.prime(corpus, callOptions);
  }

  private async executeQuery(corpus: CorpusFile, question: string, callOptions: KnowledgeAgentCallOptions): Promise<QueryResult> {
    const claudePath = findClaudeExecutable('WORKER');
    const isolatedEnv = sanitizeEnv(await buildIsolatedEnvWithFreshOAuth());

    const { query } = await loadClaudeAgentSdk();
    const queryResult = query({
      prompt: question,
      options: buildHardenedSdkOptions({
        source: 'KnowledgeAgent',
        project: corpus.name,
        model: this.getModelId(),
        env: isolatedEnv,
        pathToClaudeCodeExecutable: claudePath,
        resume: corpus.session_id!,
        abortController: callOptions.abortController,
      }),
    });

    let answer = '';
    let newSessionId = corpus.session_id!;
    let successfulResult = false;
    try {
      for await (const msg of queryResult) {
        if (msg.session_id) newSessionId = msg.session_id;
        if (msg.type === 'result') {
          successfulResult = msg.is_error !== true && msg.subtype === 'success';
          if (!successfulResult) throw errorFromUnsuccessfulResult('query', msg);
        }
        if (msg.type === 'assistant') {
          const text = msg.message.content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('');
          answer = text;
        }
      }
    } catch (error) {
      if (callOptions.abortController?.signal.aborted) throw error;
      if (answer && successfulResult) {
        if (error instanceof Error) {
          logger.debug('WORKER', `SDK process exited after query — answer captured, continuing`, {}, error);
        } else {
          logger.debug('WORKER', `SDK process exited after query — answer captured, continuing (non-Error thrown)`, { thrownValue: String(error) });
        }
      } else {
        throw error;
      }
    }

    if (!successfulResult) {
      throw new Error(`Knowledge query ended without a successful result for corpus "${corpus.name}"`);
    }
    return { answer, session_id: newSessionId };
  }

  private getModelId(): string {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    // Resolve $TIER:<fast|smart|simple|summary> aliases at request time (#2289).
    return resolveTierAlias(settings.CLAUDE_MEM_MODEL, settings);
  }

  /**
   * Fork: with an HTTP provider selected, corpus Q&A goes to that provider's
   * OpenAI-compatible /chat/completions endpoint instead of the Claude SDK, so
   * it needs no Claude OAuth. Null for every other provider; throws when the
   * selected HTTP provider is not configured, rather than spending a Claude
   * subscription the user did not pick.
   */
  private async chatCompletionsEndpoint(): Promise<ChatCompletionsEndpoint | null> {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    if (settings.CLAUDE_MEM_PROVIDER === 'openai-compatible') {
      const { resolveOpenAICompatConfig } = await import('../OpenAICompatProvider.js');
      const config = resolveOpenAICompatConfig(USER_SETTINGS_PATH);
      if (!config.apiUrl || !config.model || (!config.apiKey && config.requiresApiKey)) {
        throw new Error('openai-compatible provider not configured. Set CLAUDE_MEM_OPENAI_COMPAT_BASE_URL (or _PRESET), _MODEL and _API_KEY.');
      }
      // Q&A may use a stronger model than bulk generation; empty = the provider's model.
      const qaModel = (settings.CLAUDE_MEM_OPENAI_COMPAT_QA_MODEL || '').trim();
      return {
        apiUrl: config.apiUrl,
        model: (qaModel && resolveTierAlias(qaModel, settings)) || config.model,
        headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
      };
    }

    if (settings.CLAUDE_MEM_PROVIDER !== 'openrouter') return null;

    const { getCredential } = await import('../../../shared/EnvManager.js');
    const apiKey = settings.CLAUDE_MEM_OPENROUTER_API_KEY || getCredential('OPENROUTER_API_KEY') || '';
    if (!apiKey) {
      throw new Error('OpenRouter API key not configured. Set CLAUDE_MEM_OPENROUTER_API_KEY in settings or OPENROUTER_API_KEY environment variable.');
    }
    return {
      apiUrl: resolveOpenRouterChatCompletionsUrl(settings.CLAUDE_MEM_OPENROUTER_BASE_URL || process.env.OPENROUTER_BASE_URL || ''),
      // Q&A uses its own (typically stronger) model than bulk generation — see
      // resolveOpenRouterQaModel. Falls back to CLAUDE_MEM_OPENROUTER_MODEL.
      model: resolveOpenRouterQaModel(settings),
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(settings.CLAUDE_MEM_OPENROUTER_SITE_URL ? { 'HTTP-Referer': settings.CLAUDE_MEM_OPENROUTER_SITE_URL } : {}),
        ...(settings.CLAUDE_MEM_OPENROUTER_APP_NAME ? { 'X-Title': settings.CLAUDE_MEM_OPENROUTER_APP_NAME } : {}),
      },
    };
  }

  private async queryChatCompletionsCorpus(
    endpoint: ChatCompletionsEndpoint,
    corpus: CorpusFile,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<QueryResult> {
    const { apiUrl, model } = endpoint;
    const renderedCorpus = this.renderer.renderCorpus(corpus);

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...endpoint.headers },
      signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: corpus.system_prompt },
          {
            role: 'user',
            content: [
              'Use this knowledge corpus as the historical context for all answers:',
              '',
              renderedCorpus,
            ].join('\n'),
          },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Corpus query failed (${response.status}): ${body.slice(0, 500)}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const answer = data.choices?.[0]?.message?.content ?? '';
    return { answer, session_id: corpus.session_id ?? `openrouter-corpus-${corpus.name}` };
  }

}
