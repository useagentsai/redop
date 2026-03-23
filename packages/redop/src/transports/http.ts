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
      sessions.set(id, { createdAt: Date.now(), id, lastSeen: Date.now() });
      return id;
    },
    delete(id: string) {
      sessions.delete(id);
    },
    stop() {
      clearInterval(gcTimer);
    },
    touch(id: string): boolean {
      const s = sessions.get(id);
      if (!s) {
        return false;
      }
      s.lastSeen = Date.now();
      return true;
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
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-API-Key, Mcp-Session-Id",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Origin": requestOrigin ?? "*",
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
    "Access-Control-Allow-Credentials": String(cors.credentials ?? true),
    "Access-Control-Allow-Headers": (
      cors.headers ?? [
        "Content-Type",
        "Authorization",
        "X-API-Key",
        "Mcp-Session-Id",
      ]
    ).join(", "),
    "Access-Control-Allow-Methods": (
      cors.methods ?? ["GET", "POST", "DELETE", "OPTIONS"]
    ).join(", "),
    "Access-Control-Allow-Origin": allowedOrigin,
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
    [...headers.entries()].map(([key, value]) => [key.toLowerCase(), value])
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
      id,
      jsonrpc: "2.0",
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
    return { id, jsonrpc: "2.0", result: {} };
  }

  // ── tools/list ──
  if (method === "tools/list") {
    return {
      id,
      jsonrpc: "2.0",
      result: {
        tools: [...tools.values()].map((t) => ({
          description: t.description ?? "",
          inputSchema: t.inputSchema,
          name: t.name,
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
        error: {
          code: -32_602,
          message: `Unknown tool: ${toolName ?? "(none)"}`,
        },
        id,
        jsonrpc: "2.0",
      };
    }

    try {
      const result = await runner(toolName, p?.arguments ?? {}, requestMeta);
      return {
        id,
        jsonrpc: "2.0",
        result: {
          content: [{ text: JSON.stringify(result), type: "text" }],
          isError: false,
        },
      };
    } catch (error) {
      return {
        id,
        jsonrpc: "2.0",
        result: {
          content: [
            {
              text: String(error instanceof Error ? error.message : error),
              type: "text",
            },
          ],
          isError: true,
        },
      };
    }
  }

  return {
    error: { code: -32_601, message: `Method not found: ${method}` },
    id,
    jsonrpc: "2.0",
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
        return new Response(null, { headers: corsHeaders, status: 204 });
      }

      // ── Origin guard (DNS-rebinding protection) ──
      if (!isOriginAllowed(origin, opts.cors, hostname, port)) {
        return new Response(
          JSON.stringify({
            error: { code: -32_600, message: "Forbidden: invalid Origin" },
            id: null,
            jsonrpc: "2.0",
          }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 403,
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
          cancel() {
            clearInterval(heartbeat);
            sseClients.delete(sessionId);
            sessions.delete(sessionId);
          },
          start(controller) {
            sseClients.set(sessionId, controller);

            const encode = (s: string) => new TextEncoder().encode(s);

            // Initial endpoint event
            controller.enqueue(
              encode(
                `event: endpoint\ndata: ${JSON.stringify({
                  sessionId,
                  uri: `${url.origin}${mcpPath}`,
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
        });

        return new Response(stream, {
          headers: {
            ...corsHeaders,
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Content-Type": "text/event-stream",
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
            headers: corsHeaders,
            status: 413,
          });
        }

        let body: JsonRpcRequest;
        try {
          body = (await req.json()) as JsonRpcRequest;
        } catch {
          return Response.json(
            {
              error: { code: -32_700, message: "Parse error" },
              id: null,
              jsonrpc: "2.0",
            },
            { headers: corsHeaders, status: 400 }
          );
        }
        // AFTER — allows Streamable HTTP clients that POST without a session
        const incomingSessionId = req.headers.get("mcp-session-id") ?? "";
        let sessionId: string;
        if (incomingSessionId) {
          if (!sessions.touch(incomingSessionId)) {
            return Response.json(
              {
                error: {
                  code: -32_600,
                  message: "Unknown or expired session.",
                },
                id: body?.id ?? null,
                jsonrpc: "2.0",
              },
              { headers: corsHeaders, status: 400 }
            );
          }
          sessionId = incomingSessionId;
        } else {
          sessionId = sessions.create();
        }

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

      return new Response("Not Found", { headers: corsHeaders, status: 404 });
    },

    error(err) {
      console.error("[redop] server error:", err);
      return new Response("Internal Server Error", { status: 500 });
    },
  });

  const url = `http${opts.tls ? "s" : ""}://${hostname}:${port}${mcpPath}`;
  opts.onListen?.({ hostname, port, url });

  return {
    broadcast(sessionId: string, event: string, data: unknown) {
      const ctrl = sseClients.get(sessionId);
      if (ctrl) {
        const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        ctrl.enqueue(new TextEncoder().encode(msg));
      }
    },
    stop() {
      sessions.stop();
      server.stop();
    },
  };
}
