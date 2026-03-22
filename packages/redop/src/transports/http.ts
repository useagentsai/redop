/** biome-ignore-all lint/style/noNestedTernary: <explanation> */
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
    const { name, title, version, description, icons, websiteUrl } = serverInfo;

    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name,
          version,
          ...(title ? { title } : {}),
          ...(description ? { description } : {}),
          ...(icons?.length ? { icons } : {}),
          ...(websiteUrl ? { websiteUrl } : {}),
        },
        // instructions lives at the top level of InitializeResult, not inside serverInfo
        ...(serverInfo.instructions
          ? { instructions: serverInfo.instructions }
          : {}),
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

// ── Origin validation ─────────────────────────
function isOriginAllowed(
  origin: string | null,
  cors: ListenOptions["cors"],
  hostname: string,
  port: number
): boolean {
  // Non-browser clients don't send Origin — not a DNS rebinding risk.
  if (!origin) {
    return true;
  }

  // cors: true  →  permissive dev mode, mirror any origin
  if (cors === true) {
    return true;
  }

  // cors: false/undefined  →  default to localhost-only
  if (!cors) {
    return [
      `http://${hostname}:${port}`,
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
    ].includes(origin);
  }

  // cors: CorsOptions  →  validate against origins allowlist
  const origins = cors.origins
    ? Array.isArray(cors.origins)
      ? cors.origins
      : [cors.origins]
    : ["*"];

  // "*" in the list means explicitly open — treat like dev mode
  if (origins.includes("*")) {
    return true;
  }

  return origins.includes(origin);
}

// ── HTTP server ───────────────────────────────

export function startHttpTransport(
  tools: Map<string, ResolvedTool>,
  runner: ToolRunner,
  opts: ListenOptions,
  serverInfo: Required<ServerInfoOptions>
) {
  const port = Number(opts.port ?? 3000);
  const hostname = opts.hostname ?? "127.0.0.1";
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

      // ── Origin guard (DNS-rebinding protection) ──
      if (!isOriginAllowed(origin, opts.cors, hostname, port)) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32_600, message: "Forbidden: invalid Origin" },
          }),
          {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      // ── Health check ──
      if (req.method === "GET" && url.pathname === `${mcpPath}/health`) {
        return Response.json(
          { ok: true, tools: tools.size },
          { headers: corsHeaders }
        );
      }

      // ── SSE stream (GET /mcp) ──
      if (req.method === "GET" && url.pathname === mcpPath) {
        const incomingSessionId = req.headers.get("mcp-session-id") ?? "";
        const sessionId =
          incomingSessionId && sessions.touch(incomingSessionId)
            ? incomingSessionId
            : sessions.create();

        let heartbeat: ReturnType<typeof setInterval>;

        const stream = new ReadableStream({
          start(controller) {
            sseClients.set(sessionId, controller);

            const encode = (s: string) => new TextEncoder().encode(s);

            // Initial endpoint event
            controller.enqueue(
              encode(
                `event: endpoint\ndata: ${JSON.stringify({
                  uri: `${url.origin}${mcpPath}`,
                  sessionId,
                })}\n\n`
              )
            );

            // Keep-alive: SSE comment every 15s
            heartbeat = setInterval(() => {
              try {
                controller.enqueue(encode(": ping\n\n"));
              } catch {
                // Stream already closed — cancel() will clean up
                clearInterval(heartbeat);
              }
            }, 15_000);
          },
          cancel() {
            clearInterval(heartbeat);
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

        const incomingSessionId = req.headers.get("mcp-session-id") ?? "";

        // Every POST must reference a session established via GET (SSE)
        if (!sessions.touch(incomingSessionId)) {
          return Response.json(
            {
              jsonrpc: "2.0",
              id: body?.id ?? null,
              error: {
                code: -32_600,
                message: "Unknown or expired session. Connect via SSE first.",
              },
            },
            { status: 400, headers: corsHeaders }
          );
        }

        const sessionId = incomingSessionId;

        // handle the json rpc request
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
