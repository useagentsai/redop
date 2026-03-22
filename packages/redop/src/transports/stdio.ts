// ─────────────────────────────────────────────
//  redop — stdio transport
//  Reads newline-delimited JSON-RPC from stdin,
//  writes responses to stdout.
// ─────────────────────────────────────────────

import type {
  JsonRpcRequest,
  RequestMeta,
  ResolvedTool,
  ServerInfoOptions,
} from "../types";

type ToolRunner = (
  toolName: string,
  args: Record<string, unknown>,
  requestMeta: RequestMeta
) => Promise<unknown>;

function buildToolList(tools: Map<string, ResolvedTool>) {
  return Array.from(tools.values()).map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema,
    ...(t.annotations ? { annotations: t.annotations } : {}),
  }));
}

async function handleMessage(
  msg: JsonRpcRequest,
  tools: Map<string, ResolvedTool>,
  runner: ToolRunner,
  serverInfo: Required<ServerInfoOptions>
) {
  const { id, method, params } = msg;

  const respond = (result: unknown) =>
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");

  const error = (code: number, message: string) =>
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"
    );

  if (method === "initialize") {
    respond({
      protocolVersion: "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo,
    });
    return;
  }

  if (method === "notifications/initialized") {
    // no response needed for notifications
    return;
  }

  if (method === "ping") {
    respond({});
    return;
  }

  if (method === "tools/list") {
    respond({ tools: buildToolList(tools) });
    return;
  }

  if (method === "tools/call") {
    const p = params as { name?: string; arguments?: Record<string, unknown> };
    const toolName = p?.name;

    if (!(toolName && tools.has(toolName))) {
      error(-32_602, `Unknown tool: ${toolName ?? "(none)"}`);
      return;
    }

    try {
      const result = await runner(toolName, p?.arguments ?? {}, {
        headers: {},
        transport: "stdio",
      });
      respond({
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError: false,
      });
    } catch (err) {
      respond({
        content: [
          {
            type: "text",
            text: String(err instanceof Error ? err.message : err),
          },
        ],
        isError: true,
      });
    }
    return;
  }

  error(-32_601, `Method not found: ${method}`);
}

export function startStdioTransport(
  tools: Map<string, ResolvedTool>,
  runner: ToolRunner,
  serverInfo: Required<ServerInfoOptions>
) {
  // Tell the host we're a MCP server over stdio
  process.stdin.setEncoding("utf8");

  let buffer = "";

  process.stdin.on("data", async (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // keep incomplete last line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let msg: JsonRpcRequest;
      try {
        msg = JSON.parse(trimmed) as JsonRpcRequest;
      } catch {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32_700, message: "Parse error" },
          }) + "\n"
        );
        continue;
      }

      await handleMessage(msg, tools, runner, serverInfo);
    }
  });

  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
}
