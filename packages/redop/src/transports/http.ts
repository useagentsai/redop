// ─────────────────────────────────────────────
//  redop — HTTP transport (Bun-native)
// ─────────────────────────────────────────────

import type {
  JsonRpcRequest,
  JsonRpcResponse,
  ListenOptions,
  RequestMeta,
  ResolvedTool,
  ServerInfoOptions,
} from "../types";

// ── Session store ─────────────────────────────

interface Session {
  createdAt: number;
  id: string;
  lastSeen: number;
}

function createSessionStore(timeoutMs: number) {
  const sessions = new Map<string, Session>();

  function gc() {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.lastSeen > timeoutMs) {
        sessions.delete(id);
      }
    }
  }

  // GC every 30 seconds
  const gcTimer = setInterval(gc, 30_000);

  return {
    create(): string {
      const id = crypto.randomUUID();
      sessions.set(id, { id, createdAt: Date.now(), lastSeen: Date.now() });
      return id;
    },
    touch(id: string): boolean {
      const s = sessions.get(id);
      if (!s) {
        return false;
      }
      s.lastSeen = Date.now();
      return true;
    },
    delete(id: string) {
      sessions.delete(id);
    },
    stop() {
      clearInterval(gcTimer);
    },
  };
}

// ── CORS helpers ──────────────────────────────

function buildCorsHeaders(
  cors: ListenOptions["cors"],
  requestOrigin?: string | null
): Record<string, string> {
  if (!cors) {
    return {};
  }

  if (cors === true) {
    return {
      "Access-Control-Allow-Origin": requestOrigin ?? "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-API-Key, Mcp-Session-Id",
      "Access-Control-Allow-Credentials": "true",
    };
  }

  const origins = Array.isArray(cors.origins)
    ? cors.origins
    : cors.origins
      ? [cors.origins]
      : ["*"];

  const allowedOrigin =
    requestOrigin && origins.includes(requestOrigin)
      ? requestOrigin
      : (origins[0] ?? "*");

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": (
      cors.methods ?? ["GET", "POST", "DELETE", "OPTIONS"]
    ).join(", "),
    "Access-Control-Allow-Headers": (
      cors.headers ?? [
        "Content-Type",
        "Authorization",
        "X-API-Key",
        "Mcp-Session-Id",
      ]
    ).join(", "),
    "Access-Control-Allow-Credentials": String(cors.credentials ?? true),
  };
}

// ── MCP JSON-RPC handler ──────────────────────

type ToolRunner = (
  toolName: string,
  args: Record<string, unknown>,
  requestMeta: RequestMeta
) => Promise<unknown>;

function getRequestHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(
    Array.from(headers.entries()).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ])
  );
}

async function handleJsonRpc(
  body: JsonRpcRequest,
  tools: Map<string, ResolvedTool>,
  runner: ToolRunner,
  requestMeta: RequestMeta,
  serverInfo: Required<ServerInfoOptions>,
  sessionId: string
): Promise<JsonRpcResponse> {
  const { id, method, params } = body;

  // ── initialize ──
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo,
        sessionId,
      },
    };
  }

  // ── ping ──
  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  // ── tools/list ──
  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: Array.from(tools.values()).map((t) => ({
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema,
          ...(t.annotations ? { annotations: t.annotations } : {}),
        })),
      },
    };
  }

  // ── tools/call ──
  if (method === "tools/call") {
    const p = params as { name?: string; arguments?: Record<string, unknown> };
    const toolName = p?.name;

    if (!(toolName && tools.has(toolName))) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32_602,
          message: `Unknown tool: ${toolName ?? "(none)"}`,
        },
      };
    }

    try {
      const result = await runner(toolName, p?.arguments ?? {}, requestMeta);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result) }],
          isError: false,
        },
      };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: String(err instanceof Error ? err.message : err),
            },
          ],
          isError: true,
        },
      };
    }
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32_601, message: `Method not found: ${method}` },
  };
}

// ── HTTP server ───────────────────────────────

export function startHttpTransport(
  tools: Map<string, ResolvedTool>,
  runner: ToolRunner,
  opts: ListenOptions,
  serverInfo: Required<ServerInfoOptions>
) {
  const port = Number(opts.port ?? 3000);
  const hostname = opts.hostname ?? "localhost";
  const mcpPath = opts.path ?? "/mcp";
  const sessionTimeout = opts.sessionTimeout ?? 30_000;
  const maxBodySize = opts.maxBodySize ?? 4 * 1024 * 1024;
  const sessions = createSessionStore(sessionTimeout);

  // SSE clients: sessionId → controller
  const sseClients = new Map<string, ReadableStreamDefaultController>();

  const server = Bun.serve({
    port,
    hostname,
    ...(opts.tls ? { tls: opts.tls } : {}),

    async fetch(req, server) {
      const url = new URL(req.url);
      const origin = req.headers.get("origin");
      const corsHeaders = buildCorsHeaders(opts.cors, origin);

      // ── Preflight ──
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // ── Health check ──
      if (req.method === "GET" && url.pathname === `${mcpPath}/health`) {
        return Response.json(
          { ok: true, tools: tools.size },
          { headers: corsHeaders }
        );
      }

      // ── Schema / discovery ──
      if (req.method === "GET" && url.pathname === `${mcpPath}/schema`) {
        const schema = {
          openapi: "3.1.0",
          info: {
            title: `${serverInfo.name} MCP server`,
            version: serverInfo.version,
          },
          paths: Object.fromEntries(
            Array.from(tools.values()).map((t) => [
              `/tools/${t.name}`,
              {
                post: {
                  summary: t.description,
                  requestBody: {
                    content: { "application/json": { schema: t.inputSchema } },
                  },
                },
              },
            ])
          ),
        };
        return Response.json(schema, { headers: corsHeaders });
      }

      // ── SSE stream (GET /mcp) ──
      if (req.method === "GET" && url.pathname === mcpPath) {
        let sessionId = req.headers.get("mcp-session-id") ?? "";
        if (!sessions.touch(sessionId)) {
          sessionId = sessions.create();
        }

        const stream = new ReadableStream({
          start(controller) {
            sseClients.set(sessionId, controller);
            // Send initial endpoint event
            const event = `event: endpoint\ndata: ${JSON.stringify({
              uri: `${url.origin}${mcpPath}`,
              sessionId,
            })}\n\n`;
            controller.enqueue(new TextEncoder().encode(event));
          },
          cancel() {
            sseClients.delete(sessionId);
            sessions.delete(sessionId);
          },
        });

        return new Response(stream, {
          headers: {
            ...corsHeaders,
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Mcp-Session-Id": sessionId,
          },
        });
      }

      // ── JSON-RPC (POST /mcp) ──
      if (req.method === "POST" && url.pathname === mcpPath) {
        // Body size guard
        const contentLength = Number(req.headers.get("content-length") ?? 0);
        if (contentLength > maxBodySize) {
          return new Response("Payload Too Large", {
            status: 413,
            headers: corsHeaders,
          });
        }

        let body: JsonRpcRequest;
        try {
          body = (await req.json()) as JsonRpcRequest;
        } catch {
          return Response.json(
            {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32_700, message: "Parse error" },
            },
            { status: 400, headers: corsHeaders }
          );
        }

        // Session management
        let sessionId = req.headers.get("mcp-session-id") ?? "";
        if (!sessions.touch(sessionId)) {
          sessionId = sessions.create();
        }

        const result = await handleJsonRpc(
          body,
          tools,
          runner,
          {
            headers: getRequestHeaders(req.headers),
            ip: server.requestIP(req)?.address,
            method: req.method,
            raw: req,
            sessionId,
            transport: "http",
            url: req.url,
          },
          serverInfo,
          sessionId
        );

        return Response.json(result, {
          headers: {
            ...corsHeaders,
            "Mcp-Session-Id": sessionId,
          },
        });
      }

      // ── Session teardown (DELETE /mcp) ──
      if (req.method === "DELETE" && url.pathname === mcpPath) {
        const sessionId = req.headers.get("mcp-session-id") ?? "";
        const ctrl = sseClients.get(sessionId);
        if (ctrl) {
          try {
            ctrl.close();
          } catch {}
          sseClients.delete(sessionId);
        }
        sessions.delete(sessionId);
        return Response.json(
          { ok: true, sessionId: sessionId || null, terminated: true },
          { headers: corsHeaders }
        );
      }

      return new Response("Not Found", { status: 404, headers: corsHeaders });
    },

    error(err) {
      console.error("[redop] server error:", err);
      return new Response("Internal Server Error", { status: 500 });
    },
  });

  const url = `http${opts.tls ? "s" : ""}://${hostname}:${port}${mcpPath}`;
  opts.onListen?.({ hostname, port, url });

  return {
    stop() {
      sessions.stop();
      server.stop();
    },
    broadcast(sessionId: string, event: string, data: unknown) {
      const ctrl = sseClients.get(sessionId);
      if (ctrl) {
        const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        ctrl.enqueue(new TextEncoder().encode(msg));
      }
    },
  };
}
