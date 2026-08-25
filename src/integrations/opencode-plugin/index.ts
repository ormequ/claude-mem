import { z } from "zod";
import path from "path";
import { SettingsDefaultsManager } from "../../shared/SettingsDefaultsManager.js";

/**
 * OpenCode plugin event contract.
 *
 * A plugin is an async function that receives a context object and returns an
 * object whose keys are OpenCode's real hook names. The hooks claude-mem binds
 * to are (authoritative source: plans/08-opencode-integration.md "Fix sequence"
 * step 1, cross-checked against OpenCode's documented plugin API):
 *
 *   - `tool.execute.before`           (input, output) — carries the tool's args
 *   - `tool.execute.after`            (input, output) — fires after every tool run
 *   - `chat.message`                  (input, output) — fires on each USER message only
 *   - `experimental.text.complete`    (input, output) — the assistant's finished text
 *   - `event`                         ({ event })     — generic bus; event.type carries the name
 *   - `experimental.chat.system.transform`             — mutates system prompt context before LLM calls
 *   - `experimental.session.compacting`               — fires when a session compacts
 *
 * Two shapes in `@opencode-ai/plugin` decide the capture path and are easy to
 * get wrong: `tool.execute.after`'s output is `{title, output, metadata}` with
 * no args (they arrive in `tool.execute.before`), and `chat.message`'s output
 * message is a `UserMessage` — assistant turns never reach it, so the finished
 * assistant text comes from `experimental.text.complete` instead.
 *
 * The generic `event` hook delivers bus events whose discriminant is
 * `event.type`. The only bus event types claude-mem reacts to are
 * `session.deleted` (forget the session mapping) and `session.idle` (best-effort
 * summarize). Session creation/observation capture is driven by the dedicated
 * `tool.execute.after` / `chat.message` hooks above, not by bus events — that is
 * the #2435 fix: the old code subscribed to non-existent bus types
 * (`session.created`, `message.updated`, `session.compacted`, `file.edited`)
 * and therefore captured nothing.
 *
 * REAL_OPENCODE_EVENT_TYPES is the allowlist of bus `event.type` values the
 * plugin is permitted to switch on. The contract test asserts the plugin only
 * references names in this list so a future typo fails CI.
 */
export const REAL_OPENCODE_EVENT_TYPES = [
  "session.idle",
  "session.deleted",
] as const;

type RealOpenCodeEventType = (typeof REAL_OPENCODE_EVENT_TYPES)[number];

/** The hook keys this plugin returns. The contract test asserts these are the real OpenCode hook names. */
export const REGISTERED_OPENCODE_HOOKS = [
  "tool.execute.before",
  "tool.execute.after",
  "chat.message",
  "experimental.text.complete",
  "event",
  "experimental.chat.system.transform",
  "experimental.session.compacting",
] as const;

interface OpenCodeProject {
  name?: string;
  path?: string;
}

interface OpenCodePluginContext {
  client: unknown;
  project: OpenCodeProject;
  directory: string;
  worktree: string;
  serverUrl: URL;
  $: unknown;
}

interface ToolExecuteAfterInput {
  tool: string;
  sessionID: string;
  callID: string;
}

interface ToolExecuteAfterOutput {
  title?: string;
  output?: string;
  metadata?: Record<string, unknown>;
  args?: Record<string, unknown>;
  state?: {
    input?: Record<string, unknown>;
    output?: unknown;
    error?: unknown;
  };
}

interface ToolExecuteBeforeOutput {
  args?: Record<string, unknown>;
}

interface TextCompleteInput {
  sessionID: string;
  messageID?: string;
  partID?: string;
}

interface TextCompleteOutput {
  text?: string;
}

interface ChatMessageOutput {
  message: {
    id?: string;
    role?: string;
    sessionID?: string;
  };
  parts: Array<{ type: string; text?: string }>;
}

interface SessionCompactingInput {
  sessionID: string;
}

interface SessionCompactingOutput {
  context?: string[];
}

interface ChatSystemTransformInput {
  sessionID?: string;
}

interface ChatSystemTransformOutput {
  system?: string[];
}

interface BusEvent {
  type: string;
  properties?: {
    sessionID?: string;
    info?: { id?: string };
  };
}

function resolveWorkerPort(): string {
  // Canonical resolution: CLAUDE_MEM_WORKER_PORT env override, else the
  // UID-derived default — identical to the rest of the codebase (#2406).
  return SettingsDefaultsManager.get("CLAUDE_MEM_WORKER_PORT");
}

function resolveWorkerHost(): string {
  return SettingsDefaultsManager.get("CLAUDE_MEM_WORKER_HOST");
}

const WORKER_BASE_URL = `http://${resolveWorkerHost()}:${resolveWorkerPort()}`;
const MAX_TOOL_RESPONSE_LENGTH = 1000;
const HARNESS_PROJECT_NAMES = new Set(["opencode", "global"]);
const MEMORY_CONTEXT_MARKER = "<claude-mem-context>";

const JSON_HEADERS: Record<string, string> = { "Content-Type": "application/json" };

function workerPostFireAndForget(
  path: string,
  body: Record<string, unknown>,
): void {
  fetch(`${WORKER_BASE_URL}${path}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ECONNREFUSED")) {
      console.warn(`[claude-mem] Worker POST ${path} failed: ${message}`);
    }
  });
}

async function workerGetText(path: string): Promise<string | null> {
  try {
    const response = await fetch(`${WORKER_BASE_URL}${path}`, { headers: JSON_HEADERS });
    if (!response.ok) {
      console.warn(`[claude-mem] Worker GET ${path} returned ${response.status}`);
      return null;
    }
    return await response.text();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ECONNREFUSED")) {
      console.warn(`[claude-mem] Worker GET ${path} failed: ${message}`);
    }
    return null;
  }
}

const contentSessionIdsByOpenCodeSessionId = new Map<string, string>();
const initializedSessionIds = new Set<string>();
// The summary prompt needs the last assistant turn; OpenCode has no hook that
// carries it, so `chat.message` records it here.
const lastAssistantMessageBySession = new Map<string, string>();
// `session.idle` fires repeatedly; only summarize when work happened since the
// previous summary, otherwise every idle burns an SDK round-trip.
const sessionsWithUnsummarizedWork = new Set<string>();
// Tool args only exist in `tool.execute.before`; hold them until `after` fires.
const toolArgsByCallId = new Map<string, Record<string, unknown>>();

const MAX_SESSION_MAP_ENTRIES = 1000;

function getOrCreateContentSessionId(openCodeSessionId: string): string {
  if (!contentSessionIdsByOpenCodeSessionId.has(openCodeSessionId)) {
    while (contentSessionIdsByOpenCodeSessionId.size >= MAX_SESSION_MAP_ENTRIES) {
      const oldestKey = contentSessionIdsByOpenCodeSessionId.keys().next().value;
      if (oldestKey !== undefined) {
        contentSessionIdsByOpenCodeSessionId.delete(oldestKey);
        initializedSessionIds.delete(oldestKey);
        lastAssistantMessageBySession.delete(oldestKey);
        sessionsWithUnsummarizedWork.delete(oldestKey);
      } else {
        break;
      }
    }
    contentSessionIdsByOpenCodeSessionId.set(
      openCodeSessionId,
      `opencode-${openCodeSessionId}-${Date.now()}`,
    );
  }
  return contentSessionIdsByOpenCodeSessionId.get(openCodeSessionId)!;
}

/**
 * The worker has no "session.created" event in OpenCode, so we lazily initialize
 * the session the first time we see any activity for it (tool run or chat
 * message). This guarantees a session row exists before observations arrive.
 */
function ensureSessionInitialized(openCodeSessionId: string, projectName: string): string {
  const contentSessionId = getOrCreateContentSessionId(openCodeSessionId);
  if (!initializedSessionIds.has(openCodeSessionId)) {
    initializedSessionIds.add(openCodeSessionId);
    workerPostFireAndForget("/api/sessions/init", {
      contentSessionId,
      project: projectName,
      prompt: "",
      platformSource: "opencode",
    });
  }
  return contentSessionId;
}

function recordUserPrompt(openCodeSessionId: string, projectName: string, prompt: string): string {
  const contentSessionId = getOrCreateContentSessionId(openCodeSessionId);
  initializedSessionIds.add(openCodeSessionId);
  workerPostFireAndForget("/api/sessions/init", {
    contentSessionId,
    project: projectName,
    prompt,
    platformSource: "opencode",
  });
  return contentSessionId;
}

function extractTextParts(output: ChatMessageOutput): string {
  return (output.parts || [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

function truncate(text: string): string {
  return text.length > MAX_TOOL_RESPONSE_LENGTH
    ? text.slice(0, MAX_TOOL_RESPONSE_LENGTH)
    : text;
}

function extractToolInput(
  callID: string,
  output: ToolExecuteAfterOutput,
): Record<string, unknown> {
  const recorded = toolArgsByCallId.get(callID);
  toolArgsByCallId.delete(callID);
  return recorded || output.args || output.state?.input || {};
}

function stringifyToolOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractToolResponse(output: ToolExecuteAfterOutput): string {
  const value = output.output ?? output.state?.output ?? output.state?.error ?? "";
  return stringifyToolOutput(value);
}

function resolveProjectName(ctx: OpenCodePluginContext): string {
  const configuredName = ctx.project?.name?.trim();
  if (configuredName && !HARNESS_PROJECT_NAMES.has(configuredName.toLowerCase())) {
    return configuredName;
  }

  const workspacePath = ctx.directory || ctx.project?.path || ctx.worktree || "";
  const basename = path.basename(workspacePath);
  return basename || configuredName || "opencode";
}

async function fetchWorkerContext(projectName: string): Promise<string | null> {
  const contextText = await workerGetText(
    `/api/context/inject?project=${encodeURIComponent(projectName)}`,
  );
  if (!contextText?.trim()) return null;
  if (contextText.includes("*No context yet.")) return null;
  return contextText.trim();
}

async function fetchInjectableContext(projectName: string): Promise<string | null> {
  const contextText = await fetchWorkerContext(projectName);
  if (!contextText) return null;
  return `${MEMORY_CONTEXT_MARKER}\n${contextText}\n</claude-mem-context>`;
}

function getMemoryInjectionKey(input: ChatSystemTransformInput, projectName: string): string {
  return input.sessionID ? `session:${input.sessionID}` : `project:${projectName}`;
}

export const ClaudeMemPlugin = async (ctx: OpenCodePluginContext) => {
  const projectName = resolveProjectName(ctx);
  const injectedMemoryContextKeys = new Set<string>();

  console.log(`[claude-mem] OpenCode plugin loading (project: ${projectName})`);

  return {
    // The args live here and nowhere else; `after` only gets title/output.
    "tool.execute.before": async (
      input: ToolExecuteAfterInput,
      output: ToolExecuteBeforeOutput,
    ): Promise<void> => {
      if (!output?.args) return;
      while (toolArgsByCallId.size >= MAX_SESSION_MAP_ENTRIES) {
        const oldestKey = toolArgsByCallId.keys().next().value;
        if (oldestKey === undefined) break;
        toolArgsByCallId.delete(oldestKey);
      }
      toolArgsByCallId.set(input.callID, output.args);
    },

    // Capture every tool execution as an observation. This is the primary
    // capture path (#2419).
    "tool.execute.after": async (
      input: ToolExecuteAfterInput,
      output: ToolExecuteAfterOutput,
    ): Promise<void> => {
      const contentSessionId = ensureSessionInitialized(input.sessionID, projectName);
      sessionsWithUnsummarizedWork.add(input.sessionID);
      workerPostFireAndForget("/api/sessions/observations", {
        contentSessionId,
        tool_name: input.tool,
        tool_input: extractToolInput(input.callID, output),
        tool_response: truncate(extractToolResponse(output)),
        cwd: ctx.directory,
        platformSource: "opencode",
        tool_use_id: input.callID,
      });
    },

    // Capture user prompts for memory alignment. OpenCode only ever hands this
    // hook a UserMessage, so there is no assistant branch to take here.
    "chat.message": async (
      input: { sessionID?: string },
      output: ChatMessageOutput,
    ): Promise<void> => {
      const sessionID = output.message?.sessionID || input?.sessionID;
      if (!sessionID) return;

      const messageText = extractTextParts(output);
      if (!messageText) return;
      if (output.message?.role && output.message.role !== "user") return;

      recordUserPrompt(sessionID, projectName, messageText);
    },

    // The assistant's finished text. This is the only hook that carries it, and
    // the summary prompt needs it.
    "experimental.text.complete": async (
      input: TextCompleteInput,
      output: TextCompleteOutput,
    ): Promise<void> => {
      const messageText = output?.text?.trim();
      if (!input?.sessionID || !messageText) return;

      const contentSessionId = ensureSessionInitialized(input.sessionID, projectName);
      lastAssistantMessageBySession.set(input.sessionID, truncate(messageText));
      sessionsWithUnsummarizedWork.add(input.sessionID);
      workerPostFireAndForget("/api/sessions/observations", {
        contentSessionId,
        tool_name: "assistant_message",
        tool_input: {},
        tool_response: truncate(messageText),
        cwd: ctx.directory,
        platformSource: "opencode",
      });
    },

    // Inject memory before each model call. OpenCode's chat.message hook only
    // observes messages after they exist; system.transform mutates LLM context.
    "experimental.chat.system.transform": async (
      input: ChatSystemTransformInput,
      output: ChatSystemTransformOutput,
    ): Promise<void> => {
      if (!output?.system) return;
      const injectionKey = getMemoryInjectionKey(input, projectName);
      if (output.system.some((entry) => entry.includes(MEMORY_CONTEXT_MARKER))) {
        injectedMemoryContextKeys.add(injectionKey);
        return;
      }
      if (injectedMemoryContextKeys.has(injectionKey)) return;

      const contextText = await fetchInjectableContext(projectName);
      if (!contextText) return;

      output.system.push(contextText);
      injectedMemoryContextKeys.add(injectionKey);
      // ponytail: OpenCode renders plugin stdout into the TUI, so the happy path
      // stays silent — set CLAUDE_MEM_DEBUG=1 to see injections again.
      if (process.env.CLAUDE_MEM_DEBUG) {
        console.log(
          `[claude-mem] Injected memory context (project: ${projectName}, chars: ${contextText.length})`,
        );
      }
    },

    // Summarize when a session compacts. This is OpenCode's real compaction
    // hook (the old `session.compacted` bus event never existed).
    "experimental.session.compacting": async (
      input: SessionCompactingInput,
      output?: SessionCompactingOutput,
    ): Promise<void> => {
      const contentSessionId = ensureSessionInitialized(input.sessionID, projectName);
      const contextText = await fetchWorkerContext(projectName);
      if (contextText && output?.context) {
        output.context.push(contextText);
      }
      sessionsWithUnsummarizedWork.delete(input.sessionID);
      workerPostFireAndForget("/api/sessions/summarize", {
        contentSessionId,
        last_assistant_message: lastAssistantMessageBySession.get(input.sessionID) ?? "",
        platformSource: "opencode",
      });
    },

    // Generic bus events. Only `session.idle` and `session.deleted` are real
    // and acted upon (see REAL_OPENCODE_EVENT_TYPES).
    event: async ({ event }: { event: BusEvent }): Promise<void> => {
      const eventType = event?.type as RealOpenCodeEventType | undefined;
      const sessionID = event?.properties?.sessionID || event?.properties?.info?.id;
      if (!sessionID) return;

      switch (eventType) {
        case "session.idle": {
          // Best-effort summarize once a session goes idle, but only when
          // something happened since the last one — idle fires repeatedly.
          if (!sessionsWithUnsummarizedWork.delete(sessionID)) break;
          const contentSessionId = ensureSessionInitialized(sessionID, projectName);
          workerPostFireAndForget("/api/sessions/summarize", {
            contentSessionId,
            last_assistant_message: lastAssistantMessageBySession.get(sessionID) ?? "",
            platformSource: "opencode",
          });
          break;
        }
        case "session.deleted": {
          contentSessionIdsByOpenCodeSessionId.delete(sessionID);
          initializedSessionIds.delete(sessionID);
          lastAssistantMessageBySession.delete(sessionID);
          sessionsWithUnsummarizedWork.delete(sessionID);
          injectedMemoryContextKeys.delete(`session:${sessionID}`);
          break;
        }
        default:
          // Ignore all other bus events.
          break;
      }
    },

    tool: {
      claude_mem_search: {
        description:
          "Search claude-mem memory database for past observations, sessions, and context",
        args: {
          query: z.string().describe("Search query for memory observations"),
        },
        async execute(args: Record<string, unknown>): Promise<string> {
          const query = String(args.query || "");
          if (!query) {
            return "Please provide a search query.";
          }

          const text = await workerGetText(
            `/api/search/observations?query=${encodeURIComponent(query)}&limit=10&project=${encodeURIComponent(projectName)}`,
          );

          if (!text) {
            return "claude-mem worker is not running. Start it with: npx claude-mem start";
          }

          return parseSearchResponse(text, query);
        },
      },
    },
  };
};

/**
 * The worker returns Claude-style `{ content: [{ type: 'text', text: '...' }] }`
 * blocks, NOT `{ items: [...] }` (#2406). Concatenate the text blocks and return
 * them verbatim; an empty block list or a "No observations found" body becomes a
 * clear no-results message.
 */
export function parseSearchResponse(text: string, query: string): string {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error: unknown) {
    console.warn(
      "[claude-mem] Failed to parse search results:",
      error instanceof Error ? error.message : String(error),
    );
    return "Failed to parse search results.";
  }

  const content = (data as { content?: Array<{ type?: string; text?: string }> }).content;
  if (!Array.isArray(content) || content.length === 0) {
    return `No results found for "${query}".`;
  }

  const rendered = content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();

  if (!rendered) {
    return `No results found for "${query}".`;
  }

  return rendered;
}

export default ClaudeMemPlugin;
