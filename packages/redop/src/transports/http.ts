// ─────────────────────────────────────────────
//  redop — HTTP transport (Streamable HTTP 2025-11-25)
// ─────────────────────────────────────────────

import type {
  CapabilityOptions,
  JsonRpcRequest,
  JsonRpcResponse,
  ListenOptions,
  PromptHandlerResult,
  RequestMeta,
  ResolvedPrompt,
  ResolvedResource,
  ResolvedTool,
  ResourceContents,
  ServerInfoOptions,
} from "../types";

// ── Task types ────────────────────────────────

type TaskStatus =
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled";

interface StoredTask {
  createdAt: string;
  lastUpdatedAt: string;
  pollInterval?: number;
  result?: Record<string, unknown>;
  rpcError?: { code: number; message: string };
  status: TaskStatus;
  statusMessage?: string;
  taskId: string;
  ttl: number | null;
  waiters: Array<() => void>;
}

// ── Helpers ───────────────────────────────────

function isoNow() {
  return new Date().toISOString();
}

function taskPublic(t: StoredTask) {
  const { waiters: _w, result: _r, rpcError: _e, ...pub } = t;
  return pub;
}

const TERMINAL = new Set<TaskStatus>(["completed", "failed", "cancelled"]);
const isTerminal = (s: TaskStatus) => TERMINAL.has(s);

function isOriginAllowed(origin: string | null, serverUrl: string): boolean {
  if (!origin) {
    return true;
  }
  try {
    const o = new URL(origin);
    const s = new URL(serverUrl);
    if (o.hostname === s.hostname) {
      return true;
    }
    const loopback = new Set(["localhost", "127.0.0.1", "::1"]);
    if (loopback.has(s.hostname) && loopback.has(o.hostname)) {
      return true;
    }
    // Allow common local dev ports for inspectors
    if (o.hostname === "localhost" || o.hostname === "127.0.0.1") {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function contentTypeForPath(pathname: string): string {
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (pathname.endsWith(".html")) return "text/html; charset=utf-8";
  return "application/octet-stream";
}

// ── Session + task store ──────────────────────

function createStore(sessionTimeoutMs: number) {
  const sessions = new Map<string, { lastSeen: number }>();
  const tasks = new Map<string, StoredTask>();

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.lastSeen > sessionTimeoutMs) {
        sessions.delete(id);
      }
    }
    for (const [, t] of tasks) {
      if (t.ttl === null) {
        continue;
      }
      if (now - new Date(t.createdAt).getTime() > t.ttl) {
        for (const w of t.waiters) {
          w();
        }
        tasks.delete(t.taskId);
      }
    }
  }, 30_000);

  return {
    sessions: {
      create() {
        const id = crypto.randomUUID();
        sessions.set(id, { lastSeen: Date.now() });
        return id;
      },
      ensure(id: string) {
        const existing = sessions.get(id);
        if (existing) {
          existing.lastSeen = Date.now();
          return id;
        }
        sessions.set(id, { lastSeen: Date.now() });
        return id;
      },
      touch(id: string) {
        const s = sessions.get(id);
        if (!s) {
          return false;
        }
        s.lastSeen = Date.now();
        return true;
      },
      has(id: string) {
        return sessions.has(id);
      },
      delete(id: string) {
        sessions.delete(id);
      },
    },
    tasks: {
      create(ttl?: number): StoredTask {
        const now = isoNow();
        const t: StoredTask = {
          taskId: crypto.randomUUID(),
          status: "working",
          createdAt: now,
          lastUpdatedAt: now,
          ttl: ttl ?? null,
          pollInterval: 2000,
          waiters: [],
        };
        tasks.set(t.taskId, t);
        return t;
      },
      get(id: string) {
        return tasks.get(id);
      },
      complete(id: string, result: Record<string, unknown>) {
        const t = tasks.get(id);
        if (!t || isTerminal(t.status)) {
          return;
        }
        t.status = "completed";
        t.lastUpdatedAt = isoNow();
        t.result = result;
        this._wake(t);
      },
      fail(id: string, error: string | { code: number; message: string }) {
        const t = tasks.get(id);
        if (!t || isTerminal(t.status)) {
          return;
        }
        t.status = "failed";
        t.lastUpdatedAt = isoNow();
        if (typeof error === "string") {
          t.statusMessage = error;
          t.result = {
            content: [{ type: "text", text: error }],
            isError: true,
          };
        } else {
          t.rpcError = error;
          t.statusMessage = error.message;
        }
        this._wake(t);
      },
      cancel(id: string) {
        const t = tasks.get(id);
        if (!t || isTerminal(t.status)) {
          return false;
        }
        t.status = "cancelled";
        t.lastUpdatedAt = isoNow();
        t.statusMessage = "Cancelled by request.";
        this._wake(t);
        return true;
      },
      list(cursor?: string, limit = 50) {
        const all = [...tasks.values()];
        const start = cursor ? Number.parseInt(cursor) : 0;
        const page = all.slice(start, start + limit);
        return {
          tasks: page.map(taskPublic),
          nextCursor:
            start + limit < all.length ? String(start + limit) : undefined,
        };
      },
      waitForCompletion(id: string): Promise<StoredTask | null> {
        return new Promise((resolve) => {
          const t = tasks.get(id);
          if (!t) {
            resolve(null);
            return;
          }
          if (isTerminal(t.status)) {
            resolve(t);
            return;
          }
          t.waiters.push(() => resolve(tasks.get(id) ?? null));
        });
      },
      _wake(t: StoredTask) {
        for (const w of t.waiters) {
          w();
        }
        t.waiters = [];
      },
    },
    stop() {
      clearInterval(timer);
    },
  };
}

// ── JSON-RPC Handlers Map ─────────────────────────

interface RpcContext {
  caps: Required<CapabilityOptions>;
  getPrompt: (
    name: string,
    args: Record<string, string> | undefined,
    req: RequestMeta
  ) => Promise<PromptHandlerResult>;
  prompts: Map<string, ResolvedPrompt>;
  protocolVersion: SupportedVersion;
  readResource: (uri: string, req: RequestMeta) => Promise<ResourceContents>;
  requestMeta: RequestMeta;
  resources: Map<string, ResolvedResource>;
  runTool: (
    name: string,
    args: Record<string, unknown>,
    meta: RequestMeta
  ) => Promise<unknown>;
  serverInfo: Required<ServerInfoOptions>;
  sessionId: string;
  store: ReturnType<typeof createStore>;
  subscribeRes: (uri: string, sid: string) => void;
  tools: Map<string, ResolvedTool>;
  unsubscribeRes: (uri: string, sid: string) => void;
}

type RpcResponsePayload = {
  result?: any;
  error?: { code: number; message: string };
};
type RpcHandler = (
  params: any,
  ctx: RpcContext
) => Promise<RpcResponsePayload> | RpcResponsePayload;

const RPC_HANDLERS: Record<string, RpcHandler> = {
  initialize: (params, ctx) => {
    const capabilities: Record<string, unknown> = {};
    if (ctx.caps.tools) {
      capabilities.tools = { listChanged: true };
    }
    if (ctx.caps.resources) {
      capabilities.resources = { subscribe: true, listChanged: true };
    }
    if (ctx.caps.prompts) {
      capabilities.prompts = { listChanged: true };
    }
    capabilities.tasks = {
      list: {},
      cancel: {},
      requests: { tools: { call: {} } },
    };

    return {
      result: {
        protocolVersion: ctx.protocolVersion,
        capabilities,
        serverInfo: ctx.serverInfo,
        instructions: ctx.serverInfo.instructions,
        sessionId: ctx.sessionId,
      },
    };
  },

  ping: () => {
    return { result: {} };
  },

  "tools/list": (params, ctx) => {
    if (!ctx.caps.tools) {
      return {
        error: { code: -32_601, message: "Tools capability not enabled" },
      };
    }
    return {
      result: {
        tools: [...ctx.tools.values()].map((t) => ({
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema,
          ...(t.title ? { title: t.title } : {}),
          ...(t.icons?.length ? { icons: t.icons } : {}),
          ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
          ...(t.annotations ? { annotations: t.annotations } : {}),
          execution: { taskSupport: t.taskSupport ?? "optional" },
        })),
      },
    };
  },

  "tools/call": async (params, ctx) => {
    if (!ctx.caps.tools) {
      return {
        error: { code: -32_601, message: "Tools capability not enabled" },
      };
    }
    const p = params as {
      name: string;
      arguments?: unknown;
      task?: { ttl?: number };
      _meta?: { progressToken?: string | number };
    };
    const tool = ctx.tools.get(p.name);
    if (!tool) {
      return { error: { code: -32_602, message: `Unknown tool: ${p.name}` } };
    }

    if (p.task !== undefined) {
      const task = ctx.store.tasks.create(p.task?.ttl);
      (async () => {
        try {
          const raw = await ctx.runTool(
            p.name,
            (p.arguments ?? {}) as Record<string, unknown>,
            ctx.requestMeta
          );
          const result: Record<string, unknown> = {
            content: [{ type: "text", text: JSON.stringify(raw) }],
            _meta: {
              "io.modelcontextprotocol/related-task": { taskId: task.taskId },
            },
          };
          if (tool.outputSchema && raw !== null && typeof raw === "object") {
            result.structuredContent = raw;
          }
          ctx.store.tasks.complete(task.taskId, result);
        } catch (e) {
          ctx.store.tasks.fail(task.taskId, String(e));
        }
      })();
      return { result: { task: taskPublic(task) } };
    }

    try {
      const raw = await ctx.runTool(
        p.name,
        (p.arguments ?? {}) as Record<string, unknown>,
        ctx.requestMeta
      );
      const result: Record<string, unknown> = {
        content: [{ type: "text", text: JSON.stringify(raw) }],
      };
      if (tool.outputSchema && raw !== null && typeof raw === "object") {
        result.structuredContent = raw;
      }
      return { result };
    } catch (e) {
      return {
        result: { content: [{ type: "text", text: String(e) }], isError: true },
      };
    }
  },

  "resources/list": (params, ctx) => {
    if (!ctx.caps.resources) {
      return {
        error: { code: -32_601, message: "Resources capability not enabled" },
      };
    }
    const staticRes = [...ctx.resources.values()].filter((r) => !r.isTemplate);
    return {
      result: {
        resources: staticRes.map((r) => ({
          uri: r.uri,
          name: r.name,
          ...(r.description ? { description: r.description } : {}),
          ...(r.mimeType ? { mimeType: r.mimeType } : {}),
          ...(r.icons?.length ? { icons: r.icons } : {}),
        })),
      },
    };
  },

  "resources/templates/list": (params, ctx) => {
    if (!ctx.caps.resources) {
      return {
        error: { code: -32_601, message: "Resources capability not enabled" },
      };
    }
    const templateRes = [...ctx.resources.values()].filter((r) => r.isTemplate);
    return {
      result: {
        resourceTemplates: templateRes.map((r) => ({
          uriTemplate: r.uri,
          name: r.name,
          ...(r.description ? { description: r.description } : {}),
          ...(r.mimeType ? { mimeType: r.mimeType } : {}),
        })),
      },
    };
  },

  "resources/read": async (params, ctx) => {
    if (!ctx.caps.resources) {
      return {
        error: { code: -32_601, message: "Resources capability not enabled" },
      };
    }
    const uri = params?.uri as string | undefined;
    if (!uri) {
      return { error: { code: -32_602, message: "Missing uri param" } };
    }
    try {
      const contents = await ctx.readResource(uri, ctx.requestMeta);
      const wireContent =
        contents.type === "text"
          ? { uri, mimeType: contents.mimeType, text: contents.text }
          : { uri, mimeType: contents.mimeType, blob: contents.blob };
      return { result: { contents: [wireContent] } };
    } catch (e) {
      return { error: { code: -32_602, message: String(e) } };
    }
  },

  "resources/subscribe": (params, ctx) => {
    if (!ctx.caps.resources) {
      return {
        error: { code: -32_601, message: "Resources capability not enabled" },
      };
    }
    const uri = params?.uri as string | undefined;
    if (!uri) {
      return { error: { code: -32_602, message: "Missing uri" } };
    }
    ctx.subscribeRes(uri, ctx.sessionId);
    return { result: {} };
  },

  "resources/unsubscribe": (params, ctx) => {
    if (!ctx.caps.resources) {
      return {
        error: { code: -32_601, message: "Resources capability not enabled" },
      };
    }
    const uri = params?.uri as string | undefined;
    if (!uri) {
      return { error: { code: -32_602, message: "Missing uri" } };
    }
    ctx.unsubscribeRes(uri, ctx.sessionId);
    return { result: {} };
  },

  "prompts/list": (params, ctx) => {
    if (!ctx.caps.prompts) {
      return {
        error: { code: -32_601, message: "Prompts capability not enabled" },
      };
    }
    return {
      result: {
        prompts: [...ctx.prompts.values()].map((p) => ({
          name: p.name,
          ...(p.description ? { description: p.description } : {}),
          ...(p.arguments?.length ? { arguments: p.arguments } : {}),
        })),
      },
    };
  },

  "prompts/get": async (params, ctx) => {
    if (!ctx.caps.prompts) {
      return {
        error: { code: -32_601, message: "Prompts capability not enabled" },
      };
    }
    const name = params?.name as string | undefined;
    const args = params?.arguments as Record<string, string> | undefined;
    if (!name) {
      return { error: { code: -32_602, message: "Missing name" } };
    }
    try {
      const raw = await ctx.getPrompt(name, args, ctx.requestMeta);
      const result = Array.isArray(raw) ? { messages: raw } : raw;
      return { result };
    } catch (e) {
      return { error: { code: -32_602, message: String(e) } };
    }
  },

  "tasks/get": (params, ctx) => {
    const task = ctx.store.tasks.get(params?.taskId);
    if (!task) {
      return { error: { code: -32_602, message: "Task not found" } };
    }
    return { result: taskPublic(task) };
  },

  "tasks/result": async (params, ctx) => {
    const taskId = params?.taskId;
    const task = ctx.store.tasks.get(taskId);
    if (!task) {
      return { error: { code: -32_602, message: "Task not found" } };
    }
    const final = await ctx.store.tasks.waitForCompletion(taskId);
    if (!final) {
      return { error: { code: -32_602, message: "Task expired" } };
    }
    if (final.rpcError) {
      return { error: final.rpcError };
    }
    return {
      result: {
        ...final.result,
        _meta: { "io.modelcontextprotocol/related-task": { taskId } },
      },
    };
  },

  "tasks/list": (params, ctx) => {
    const { tasks: taskList, nextCursor } = ctx.store.tasks.list(
      params?.cursor
    );
    return {
      result: nextCursor
        ? { tasks: taskList, nextCursor }
        : { tasks: taskList },
    };
  },

  "tasks/cancel": (params, ctx) => {
    const taskId = params?.taskId;
    const task = ctx.store.tasks.get(taskId);
    if (!task) {
      return { error: { code: -32_602, message: "Task not found" } };
    }
    if (isTerminal(task.status)) {
      return {
        error: {
          code: -32_602,
          message: `Already in terminal status '${task.status}'`,
        },
      };
    }
    ctx.store.tasks.cancel(taskId);
    return { result: taskPublic(ctx.store.tasks.get(taskId)!) };
  },
};

// ── JSON-RPC dispatcher ───────────────────────

async function handleJsonRpc(
  body: JsonRpcRequest,
  tools: Map<string, ResolvedTool>,
  resources: Map<string, ResolvedResource>,
  prompts: Map<string, ResolvedPrompt>,
  runTool: (
    name: string,
    args: Record<string, unknown>,
    meta: RequestMeta
  ) => Promise<unknown>,
  readResource: (uri: string, req: RequestMeta) => Promise<ResourceContents>,
  getPrompt: (
    name: string,
    args: Record<string, string> | undefined,
    req: RequestMeta
  ) => Promise<PromptHandlerResult>,
  subscribeRes: (uri: string, sid: string) => void,
  unsubscribeRes: (uri: string, sid: string) => void,
  requestMeta: RequestMeta,
  serverInfo: Required<ServerInfoOptions>,
  caps: Required<CapabilityOptions>,
  store: ReturnType<typeof createStore>,
  sessionId: string,
  protocolVersion: SupportedVersion
): Promise<JsonRpcResponse> {
  const { id, method, params } = body;
  const handler = RPC_HANDLERS[method];

  if (!handler) {
    return {
      id,
      jsonrpc: "2.0",
      error: { code: -32_601, message: "Method not found" },
    };
  }

  // Pack variables into a context object for the handler
  const ctx: RpcContext = {
    tools,
    resources,
    prompts,
    runTool,
    readResource,
    getPrompt,
    subscribeRes,
    unsubscribeRes,
    requestMeta,
    serverInfo,
    caps,
    store,
    sessionId,
    protocolVersion,
  };

  try {
    const responsePayload = await handler(params, ctx);
    return { id, jsonrpc: "2.0", ...responsePayload };
  } catch (err) {
    return {
      id,
      jsonrpc: "2.0",
      error: { code: -32_603, message: `Internal error: ${err}` },
    };
  }
}

// ── HTTP transport ────────────────────────────

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-03-26", "2024-11-05"] as const;
type SupportedVersion = (typeof SUPPORTED_VERSIONS)[number];

function negotiateVersion(clientVersion: string | undefined): SupportedVersion {
  if (!clientVersion) {
    return SUPPORTED_VERSIONS[0];
  }
  const match = SUPPORTED_VERSIONS.find((version) => version === clientVersion);
  return match ?? SUPPORTED_VERSIONS[0];
}

export function startHttpTransport(
  tools: Map<string, ResolvedTool>,
  resources: Map<string, ResolvedResource>,
  prompts: Map<string, ResolvedPrompt>,
  runTool: (
    name: string,
    args: Record<string, unknown>,
    meta: RequestMeta
  ) => Promise<unknown>,
  readResource: (uri: string, req: RequestMeta) => Promise<ResourceContents>,
  getPrompt: (
    name: string,
    args: Record<string, string> | undefined,
    req: RequestMeta
  ) => Promise<PromptHandlerResult>,
  subscribeRes: (uri: string, sid: string) => void,
  unsubscribeRes: (uri: string, sid: string) => void,
  opts: ListenOptions,
  serverInfo: Required<ServerInfoOptions>,
  caps: Required<CapabilityOptions>
) {
  const port = Number(opts.port ?? 3000);
  const hostname = opts.hostname ?? "127.0.0.1";
  const debug = opts.debug ?? false;
  const store = createStore(opts.sessionTimeout ?? 60_000);
  const mcpPath = opts.path ?? "/mcp";
  const healthPath =
    opts.health === true
      ? "/health"
      : opts.health && typeof opts.health === "object"
        ? (() => {
            const path = opts.health.path?.trim() || "/health";
            return path.startsWith("/") ? path : `/${path}`;
          })()
        : null;
  const sseClients = new Map<
    string,
    ReadableStreamDefaultController<Uint8Array>
  >();
  const enc = new TextEncoder();
  const devUIEnabled = opts.devUI ?? process.env.NODE_ENV !== "production";
  let devUiAssetsPromise:
    | Promise<{ assets: Map<string, ReturnType<typeof Bun.file>>; html: string }>
    | undefined;

  if (healthPath && healthPath === mcpPath) {
    throw new Error("[redop:http] health path cannot match the MCP path");
  }

  function getDevUiAssets() {
    if (!devUiAssetsPromise) {
      devUiAssetsPromise = (async () => {
        const htmlUrl = new URL("./ui/index.html", import.meta.url);
        const htmlFile = Bun.file(htmlUrl);
        const html = await htmlFile.text();
        const assetPaths = [...html.matchAll(/(?:href|src)="([^"]+)"/g)]
          .map((match) => match[1]!)
          .filter(
            (assetPath) =>
              assetPath.startsWith("./") || assetPath.startsWith("../"),
          );
        const assets = new Map<string, ReturnType<typeof Bun.file>>();

        for (const assetPath of assetPaths) {
          const requestPath = new URL(assetPath, "https://redop.local/").pathname;
          const assetUrl = new URL(assetPath, htmlUrl);
          assets.set(requestPath, Bun.file(assetUrl));
        }

        return { html, assets };
      })();
    }

    return devUiAssetsPromise;
  }

  function debugLog(event: string, data: Record<string, unknown>) {
    if (!debug) {
      return;
    }
    console.error(`[redop:http] ${event}`, data);
  }

  function sseChunk(data: string) {
    return enc.encode(data);
  }

  function pushSse(sid: string, data: unknown) {
    const ctrl = sseClients.get(sid);
    if (!ctrl) {
      return;
    }
    ctrl.enqueue(
      sseChunk(`id: ${crypto.randomUUID()}\ndata: ${JSON.stringify(data)}\n\n`)
    );
  }

  function pushLegacyEndpointEvent(
    ctrl: ReadableStreamDefaultController<Uint8Array>,
    sessionId: string,
    origin: string
  ) {
    ctrl.enqueue(
      sseChunk(
        `event: endpoint\ndata: ${JSON.stringify({ sessionId, uri: `${origin}${mcpPath}` })}\n\n`
      )
    );
  }

  const server = Bun.serve({
    port,
    hostname,
    idleTimeout: 255,
    development: devUIEnabled,
    async fetch(req) {
      const url = new URL(req.url);
      const origin = req.headers.get("origin");
      const ver = req.headers.get("mcp-protocol-version");
      const incomingSessionId = req.headers.get("mcp-session-id");

      debugLog("request", {
        method: req.method,
        url: req.url,
        protocolVersion: ver,
        sessionId: incomingSessionId,
        accept: req.headers.get("accept"),
        origin,
      });

      // Origin guard (DNS-rebinding)
      if (!isOriginAllowed(origin, req.url)) {
        debugLog("forbidden_origin", { origin, url: req.url });
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32_600, message: "Forbidden" },
          }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }

      // CORS preflight
      if (req.method === "OPTIONS") {
        debugLog("preflight", { url: req.url });
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": origin ?? "*",
            "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
            "Access-Control-Allow-Headers":
              "Content-Type, Accept, MCP-Session-Id, MCP-Protocol-Version, Last-Event-ID",
          },
        });
      }

      if (devUIEnabled && req.method === "GET") {
        if (url.pathname === "/") {
          const { html } = await getDevUiAssets();
          return new Response(html, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }

        const { assets } = await getDevUiAssets();
        const asset = assets.get(url.pathname);
        if (asset) {
          return new Response(asset, {
            headers: { "Content-Type": contentTypeForPath(url.pathname) },
          });
        }
      }

      // ── Provide the data the UI needs
      if (
        req.method === "GET" &&
        url.pathname === "/_debug/data" &&
        devUIEnabled
      ) {
        const data = {
          capabilities: caps,
          serverInfo,
          tools: [...tools.values()],
          resources: [...resources.values()],
          prompts: [...prompts.values()],
          mcpPath,
        };
        debugLog("debug_data", { url: req.url });
        return Response.json(data);
      }

      if (
        healthPath &&
        (req.method === "GET" || req.method === "HEAD") &&
        url.pathname === healthPath
      ) {
        debugLog("health", { method: req.method, path: url.pathname });
        if (req.method === "HEAD") {
          return new Response(null, { status: 200 });
        }

        return Response.json({
          ok: true,
          mcpPath,
          service: serverInfo.name,
          transport: "http",
        });
      }

      // Protocol version check
      if (ver && !SUPPORTED_VERSIONS.includes(ver as SupportedVersion)) {
        debugLog("unsupported_version", { url: req.url, protocolVersion: ver });
        return Response.json(
          { error: "Unsupported MCP-Protocol-Version" },
          { status: 400 }
        );
      }

      if (url.pathname !== mcpPath) {
        debugLog("not_found", { method: req.method, path: url.pathname });
        return new Response("Not Found", { status: 404 });
      }

      // DELETE — session termination
      if (req.method === "DELETE") {
        const sid = req.headers.get("mcp-session-id");
        if (sid && store.sessions.has(sid)) {
          debugLog("session_closed", { sessionId: sid });
          store.sessions.delete(sid);
          try {
            sseClients.get(sid)?.close();
          } catch {}
          sseClients.delete(sid);
          return Response.json(
            { ok: true, sessionId: sid, terminated: true },
            { status: 200 }
          );
        }
        if (sid) {
          debugLog("session_close_missing", { sessionId: sid });
          return Response.json(
            { ok: true, sessionId: sid, terminated: false },
            { status: 200 }
          );
        }
        debugLog("session_close_without_id", { url: req.url });
        return Response.json(
          { ok: true, sessionId: null, terminated: false },
          { status: 200 }
        );
      }

      // GET — SSE stream
      if (req.method === "GET") {
        if (!(req.headers.get("accept") ?? "").includes("text/event-stream")) {
          debugLog("sse_not_acceptable", {
            accept: req.headers.get("accept"),
            sessionId: incomingSessionId,
          });
          return new Response("Not Acceptable", { status: 406 });
        }
        const sid =
          req.headers.get("mcp-session-id") ?? store.sessions.create();
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(ctrl) {
            sseClients.set(sid, ctrl);
            pushLegacyEndpointEvent(ctrl, sid, url.origin);
            ctrl.enqueue(sseChunk(`id: ${crypto.randomUUID()}\ndata: \n\n`));
            heartbeat = setInterval(() => {
              try {
                ctrl.enqueue(sseChunk(`: keep-alive ${Date.now()}\n\n`));
              } catch {
                if (heartbeat) {
                  clearInterval(heartbeat);
                }
              }
            }, 5000);
            debugLog("sse_open", { sessionId: sid });
          },
          cancel() {
            if (heartbeat) {
              clearInterval(heartbeat);
            }
            sseClients.delete(sid);
            debugLog("sse_closed", { sessionId: sid });
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Mcp-Session-Id": sid,
            "Access-Control-Allow-Origin": origin ?? "*",
          },
        });
      }

      // POST — JSON-RPC
      if (req.method === "POST") {
        let body: JsonRpcRequest;
        try {
          body = (await req.json()) as JsonRpcRequest;
        } catch {
          debugLog("parse_error", { url: req.url });
          return Response.json(
            {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32_700, message: "Parse error" },
            },
            { status: 400 }
          );
        }

        if (body.id === undefined || body.id === null || !body.method) {
          debugLog("ignored_message", { body });
          return new Response(null, { status: 202 });
        }

        const sid = req.headers.get("mcp-session-id");
        let activeSession: string;
        if (sid) {
          if (store.sessions.touch(sid)) {
            activeSession = sid;
          } else {
            activeSession = store.sessions.ensure(sid);
            debugLog("session_adopted", {
              method: body.method,
              requestId: body.id,
              sessionId: sid,
            });
          }
        } else {
          activeSession = store.sessions.create();
          debugLog("session_created_for_post", {
            method: body.method,
            requestId: body.id,
            sessionId: activeSession,
          });
        }

        if (body.method !== "initialize" && !sid) {
          debugLog("legacy_post_without_session", {
            method: body.method,
            requestId: body.id,
            sessionId: activeSession,
          });
        }

        const protocolVersion = negotiateVersion(
          body.method === "initialize"
            ? ((body.params as { protocolVersion?: string } | undefined)
                ?.protocolVersion ??
                ver ??
                undefined)
            : (ver ?? undefined)
        );

        debugLog("rpc_request", {
          requestId: body.id,
          method: body.method,
          sessionId: activeSession,
          protocolVersion,
        });

        if (body.method === "initialize") {
          debugLog("initialize", {
            requestId: body.id,
            headerVersion: ver,
            requestedVersion: (
              body.params as { protocolVersion?: string } | undefined
            )?.protocolVersion,
            negotiatedVersion: protocolVersion,
            sessionId: activeSession,
          });
        }

        // Wire progress callback
        const progressToken = (body.params as any)?._meta?.progressToken as
          | string
          | number
          | undefined;
        const progressCallback =
          progressToken === undefined
            ? undefined
            : (p: { progress: number; total?: number; message?: string }) => {
                pushSse(activeSession, {
                  jsonrpc: "2.0",
                  method: "notifications/progress",
                  params: { progressToken, ...p },
                });
              };

        const requestMeta: RequestMeta = {
          headers: Object.fromEntries(req.headers.entries()),
          method: req.method,
          progressCallback,
          raw: req,
          sessionId: activeSession,
          transport: "http",
          url: req.url,
          abortSignal: (req as any).signal,
        };

        const response = await handleJsonRpc(
          body,
          tools,
          resources,
          prompts,
          runTool,
          readResource,
          getPrompt,
          subscribeRes,
          unsubscribeRes,
          requestMeta,
          serverInfo,
          caps,
          store,
          activeSession,
          protocolVersion
        );

        debugLog("rpc_response", {
          requestId: body.id,
          method: body.method,
          sessionId: activeSession,
          protocolVersion,
          hasError: "error" in response,
        });

        return Response.json(response, {
          headers: {
            "Mcp-Session-Id": activeSession,
            "Mcp-Protocol-Version": protocolVersion,
            "Access-Control-Allow-Origin": origin ?? "*",
          },
        });
      }

      debugLog("method_not_allowed", {
        method: req.method,
        path: url.pathname,
      });
      return new Response("Method Not Allowed", { status: 405 });
    },
  });

  const url = `http${opts.tls ? "s" : ""}://${hostname}:${port}${mcpPath}`;
  opts.onListen?.({ hostname, port, url });

  return {
    stop() {
      store.stop();
      server.stop();
    },
    broadcast(sid: string, data: unknown) {
      pushSse(sid, data);
    },
  };
}
