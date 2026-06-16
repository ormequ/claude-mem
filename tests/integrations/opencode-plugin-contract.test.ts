import { describe, it, expect } from "bun:test";
import { join } from "path";
import { pathToFileURL } from "url";
import {
  ClaudeMemPlugin,
  parseSearchResponse,
  REGISTERED_OPENCODE_HOOKS,
  REAL_OPENCODE_EVENT_TYPES,
} from "../../src/integrations/opencode-plugin/index";

/**
 * Regression guard for plan-08 (OpenCode event-contract correctness).
 *
 * The old plugin subscribed to bus event names that do not exist in OpenCode
 * (`session.created`, `message.updated`, `session.compacted`, `file.edited`,
 * `session.deleted` on a `(name, payload)` switch) and parsed `data.items`
 * instead of the worker's real `data.content` blocks — so it captured nothing
 * and search always returned "No results". These tests fail CI if either
 * contract regresses.
 */

// The real OpenCode plugin hook names. Anything the plugin returns as a hook
// key must be in this allowlist; a future typo (e.g. "session.created") fails.
const REAL_OPENCODE_HOOK_NAMES = new Set<string>([
  "tool.execute.after",
  "chat.message",
  "event",
  "experimental.session.compacting",
  "tool.execute.before",
  "permission.ask",
  "auth",
  "config",
  // `tool` is the custom-tool registration map, part of the plugin return shape.
  "tool",
]);

// Bus event names the old code used that DO NOT exist in OpenCode's contract.
const PHANTOM_BUS_EVENT_NAMES = [
  "session.created",
  "message.updated",
  "session.compacted",
  "file.edited",
];

const pluginCtx = {
  client: {},
  project: { name: "test-project", path: "/tmp/x" },
  directory: "/tmp/x",
  worktree: "/tmp/x",
  serverUrl: new URL("http://127.0.0.1:1234"),
  $: {},
};

const mksOpenCodeCtx = {
  ...pluginCtx,
  project: { name: "opencode", path: "/Users/belokobylskiiilia/Development/MKS" },
  directory: "/Users/belokobylskiiilia/Development/MKS",
  worktree: "opencode",
};

describe("OpenCode plugin event contract", () => {
  it("builds an OpenCode runtime bundle with exactly one plugin function export", async () => {
    const bundleUrl = pathToFileURL(join(process.cwd(), "dist/opencode-plugin/index.js"));
    const mod = await import(`${bundleUrl.href}?test=${Date.now()}`);
    const exports = Object.keys(mod).sort();

    expect(exports).toEqual(["ClaudeMemPlugin"]);
    expect(typeof mod.ClaudeMemPlugin).toBe("function");
  });

  it("only registers hooks that are part of OpenCode's real contract", async () => {
    const plugin = await ClaudeMemPlugin(pluginCtx);
    const hookKeys = Object.keys(plugin);

    for (const key of hookKeys) {
      expect(
        REAL_OPENCODE_HOOK_NAMES.has(key),
        `hook "${key}" is not a real OpenCode hook name`,
      ).toBe(true);
    }

    // The exported allowlist of hooks we bind to must itself be real.
    for (const hook of REGISTERED_OPENCODE_HOOKS) {
      expect(REAL_OPENCODE_HOOK_NAMES.has(hook)).toBe(true);
    }

    // The capture-critical hooks must be present.
    expect(hookKeys).toContain("tool.execute.after");
    expect(hookKeys).toContain("chat.message");
    expect(hookKeys).toContain("experimental.session.compacting");
    expect(hookKeys).toContain("event");
  });

  it("does not register the phantom bus event names as hooks", async () => {
    const plugin = await ClaudeMemPlugin(pluginCtx);
    const hookKeys = Object.keys(plugin);
    for (const phantom of PHANTOM_BUS_EVENT_NAMES) {
      expect(hookKeys).not.toContain(phantom);
    }
  });

  it("only reacts to real bus event types", () => {
    // session.idle / session.deleted are real OpenCode bus events; the phantom
    // names must never appear in the reacted-to allowlist.
    expect(REAL_OPENCODE_EVENT_TYPES).toContain("session.idle");
    expect(REAL_OPENCODE_EVENT_TYPES).toContain("session.deleted");
    for (const phantom of PHANTOM_BUS_EVENT_NAMES) {
      expect(REAL_OPENCODE_EVENT_TYPES as readonly string[]).not.toContain(phantom);
    }
  });

  it("posts observations to the worker via tool.execute.after", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify({ status: "queued" }), { status: 200 });
    }) as typeof fetch;

    try {
      const plugin = await ClaudeMemPlugin(pluginCtx);
      const toolAfter = plugin["tool.execute.after"];
      await toolAfter(
        { tool: "read", sessionID: "ses_1", callID: "c1" },
        { title: "Read", output: "file contents", metadata: {}, args: { path: "/a" } },
      );

      const initPost = posts.find((p) => p.url.includes("/api/sessions/init"));
      const obsPost = posts.find((p) => p.url.includes("/api/sessions/observations"));
      expect(initPost, "tool.execute.after should lazily init the session").toBeTruthy();
      expect(obsPost, "tool.execute.after should POST an observation").toBeTruthy();
      const obsBody = obsPost!.body as Record<string, unknown>;
      expect(obsBody.tool_name).toBe("read");
      expect(obsBody.tool_response).toBe("file contents");
      expect(obsBody.platformSource).toBe("opencode");
      expect(obsBody.tool_use_id).toBe("c1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("posts real OpenCode tool part output from state.output", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify({ status: "queued" }), { status: 200 });
    }) as typeof fetch;

    try {
      const plugin = await ClaudeMemPlugin(pluginCtx);
      const toolAfter = plugin["tool.execute.after"];
      await toolAfter(
        { tool: "bash", sessionID: "ses_real", callID: "functions.bash:1" },
        {
          type: "tool",
          tool: "bash",
          callID: "functions.bash:1",
          state: {
            status: "completed",
            input: { command: "pwd", description: "Print working directory" },
            output: "/Users/example/project",
          },
        } as never,
      );

      const obsPost = posts.find((p) => p.url.includes("/api/sessions/observations"));
      expect(obsPost, "tool.execute.after should POST an observation").toBeTruthy();
      const obsBody = obsPost!.body as Record<string, unknown>;
      expect(obsBody.tool_input).toEqual({
        command: "pwd",
        description: "Print working directory",
      });
      expect(obsBody.tool_response).toBe("/Users/example/project");
      expect(obsBody.tool_use_id).toBe("functions.bash:1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("captures user chat messages as session-init prompts with opencode platform source", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify({ status: "initialized" }), { status: 200 });
    }) as typeof fetch;

    try {
      const plugin = await ClaudeMemPlugin(pluginCtx);
      await plugin["chat.message"](
        {},
        {
          message: { role: "user", sessionID: "ses_user" },
          parts: [{ type: "text", text: "remember this opencode prompt" }],
        },
      );

      const initPost = posts.find((p) => p.url.includes("/api/sessions/init"));
      expect(initPost, "user chat message should initialize the session").toBeTruthy();
      const initBody = initPost!.body as Record<string, unknown>;
      expect(initBody.prompt).toBe("remember this opencode prompt");
      expect(initBody.platformSource).toBe("opencode");
      expect(initBody.project).toBe("test-project");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses the workspace basename instead of OpenCode's harness project name", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify({ status: "initialized" }), { status: 200 });
    }) as typeof fetch;

    try {
      const plugin = await ClaudeMemPlugin(mksOpenCodeCtx);
      await plugin["chat.message"](
        {},
        {
          message: { role: "user", sessionID: "ses_mks" },
          parts: [{ type: "text", text: "shared memory should use MKS" }],
        },
      );

      const initPost = posts.find((p) => p.url.includes("/api/sessions/init"));
      expect(initPost, "user chat message should initialize the session").toBeTruthy();
      const initBody = initPost!.body as Record<string, unknown>;
      expect(initBody.project).toBe("MKS");
      expect(initBody.platformSource).toBe("opencode");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("adds worker context during OpenCode compaction when available", async () => {
    const requestedUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      requestedUrls.push(path);
      if (path.includes("/api/context/inject")) {
        return new Response("memory context from worker", { status: 200 });
      }
      return new Response(JSON.stringify({ status: "queued" }), { status: 200 });
    }) as typeof fetch;

    try {
      const plugin = await ClaudeMemPlugin(pluginCtx);
      const output = { context: [] as string[] };
      await plugin["experimental.session.compacting"]({ sessionID: "ses_compact" }, output);

      expect(output.context).toContain("memory context from worker");
      expect(requestedUrls.some((url) => url.includes("project=test-project"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("adds worker context for the shared workspace project during OpenCode compaction", async () => {
    const requestedUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      requestedUrls.push(path);
      if (path.includes("/api/context/inject")) {
        return new Response("mks memory context", { status: 200 });
      }
      return new Response(JSON.stringify({ status: "queued" }), { status: 200 });
    }) as typeof fetch;

    try {
      const plugin = await ClaudeMemPlugin(mksOpenCodeCtx);
      const output = { context: [] as string[] };
      await plugin["experimental.session.compacting"]({ sessionID: "ses_compact_mks" }, output);

      expect(output.context).toContain("mks memory context");
      expect(requestedUrls.some((url) => url.includes("project=MKS"))).toBe(true);
      expect(requestedUrls.some((url) => url.includes("project=opencode"))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("searches memory within the shared workspace project", async () => {
    const requestedUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const path = String(url);
      requestedUrls.push(path);
      return new Response(JSON.stringify({
        content: [{ type: "text", text: 'Found 1 observation(s) matching "grpcutil"\n\nMKS grpcutil result' }],
      }), { status: 200 });
    }) as typeof fetch;

    try {
      const plugin = await ClaudeMemPlugin(mksOpenCodeCtx);
      const result = await plugin.tool.claude_mem_search.execute({ query: "grpcutil" });

      expect(result).toContain("MKS grpcutil result");
      expect(requestedUrls.some((url) => url.includes("project=MKS"))).toBe(true);
      expect(requestedUrls.some((url) => url.includes("project=opencode"))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("OpenCode search client response-shape contract", () => {
  it("parses the worker's real data.content blocks and returns the rows", () => {
    // This is exactly what SearchManager.searchObservations returns on a hit.
    const workerResponse = JSON.stringify({
      content: [
        {
          type: "text",
          text:
            'Found 2 observation(s) matching "auth"\n\n| # | Title |\n|---|---|\n1. Added login flow\n2. Fixed token refresh',
        },
      ],
    });

    const rendered = parseSearchResponse(workerResponse, "auth");
    expect(rendered).toContain("Found 2 observation(s)");
    expect(rendered).toContain("Added login flow");
    expect(rendered).toContain("Fixed token refresh");
    expect(rendered).not.toContain("No results");
  });

  it("does NOT parse the old data.items shape (regression guard)", () => {
    // The pre-fix worker contract was wrongly assumed to be { items: [...] }.
    // A client that still reads data.items would render rows here; the real
    // client reads data.content, so this is correctly reported as no results.
    const oldShape = JSON.stringify({
      items: [{ title: "should-not-render" }, { title: "also-not" }],
    });
    const rendered = parseSearchResponse(oldShape, "auth");
    expect(rendered).toContain("No results");
    expect(rendered).not.toContain("should-not-render");
  });

  it("returns a clear no-results message for the worker's empty-content shape", () => {
    const emptyResponse = JSON.stringify({
      content: [{ type: "text", text: 'No observations found matching "zzz"' }],
    });
    const rendered = parseSearchResponse(emptyResponse, "zzz");
    expect(rendered).toContain("No observations found");
  });
});
