// ─────────────────────────────────────────────
//  redop — zod example
//  Shows full type inference from Zod schemas.
//  Run: bun run examples/with-zod.ts
// ─────────────────────────────────────────────

import { z } from "zod";
import { analytics, logger, Redop } from "../src/index";

// ── Simulated DB ──────────────────────────────

const posts = [
  {
    id: "1",
    title: "Hello redop",
    body: "Building MCP servers is fun",
    tags: ["mcp", "bun"],
  },
  {
    id: "2",
    title: "Zod schemas",
    body: "Full inference with zero overhead",
    tags: ["typescript"],
  },
];

// ── App ───────────────────────────────────────

new Redop({
  name: "with-zod",
  version: "1.0.1",
})

  .use(logger({ level: "info" }))
  .use(analytics({ sink: "console" }))
  // .use(
  //   apiKey({
  //     secret: process.env.API_SECRET ?? "dev-secret",
  //     headerName: "x-api-key",
  //     ctxKey: "apiKey",
  //   })
  // )

  // Inject timing on every request
  .onBeforeHandle(({ ctx }) => {
    (ctx as Record<string, unknown>).startedAt = performance.now();
  })
  .onAfterHandle(({ tool, ctx }) => {
    const startedAt = (ctx as Record<string, unknown>).startedAt as
      | number
      | undefined;
    const ms =
      startedAt == null ? 0 : +(performance.now() - startedAt).toFixed(2);
    console.log(`[global.after] ${tool} finished in ${ms}ms`);
  })

  // ── Post tools ────────────────────────────────

  .tool("list_posts", {
    description: "List all blog posts with optional tag filter",
    input: z.object({
      tag: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(10),
    }),
    // ↓ handler input is fully typed: { tag: string | undefined, limit: number }
    handler: ({ input }) => {
      const tag = input.tag;
      const filtered = tag ? posts.filter((p) => p.tags.includes(tag)) : posts;
      return { posts: filtered.slice(0, input.limit), total: filtered.length };
    },
  })

  .tool("get_post", {
    description: "Get a single post by ID",
    input: z.object({
      id: z.string().min(1),
    }),
    handler: ({ input }) => {
      const post = posts.find((p) => p.id === input.id);
      if (!post) {
        throw new Error(`Post not found: ${input.id}`);
      }
      return post;
    },
  })

  .tool("create_post", {
    description: "Create a new blog post",
    annotations: { destructiveHint: false },
    input: z.object({
      title: z.string().min(3).max(200),
      body: z.string().min(10),
      tags: z.array(z.string().max(30)).max(10).default([]),
    }),
    // handler receives { input, ctx, request, tool }
    handler: ({ input, request }) => {
      const post = {
        id: crypto.randomUUID().slice(0, 8),
        title: input.title,
        body: input.body,
        tags: input.tags,
      };
      posts.push(post);
      return { created: post, sourceIp: request.ip ?? "unknown" };
    },
    after: ({ result }) => {
      console.log(
        `[tool.after] created post ${result.created.id} from ${result.sourceIp}`
      );
    },
  })

  .tool("search_posts", {
    description: "Full-text search across post titles and bodies",
    input: z.object({
      query: z.string().min(1),
      field: z.enum(["title", "body", "all"]).default("all"),
    }),
    handler: ({ input }) => {
      const q = input.query.toLowerCase();
      const results = posts.filter((p) => {
        if (input.field === "title") {
          return p.title.toLowerCase().includes(q);
        }
        if (input.field === "body") {
          return p.body.toLowerCase().includes(q);
        }
        return (
          p.title.toLowerCase().includes(q) || p.body.toLowerCase().includes(q)
        );
      });
      return { results, query: input.query, count: results.length };
    },
  })

  .listen({
    port: process.env.PORT ?? 3000,
    hostname: "0.0.0.0",
    cors: true,
    onListen: ({ url }) => {
      console.log(`ins▲ redop (zod example) → ${url}`);
    },
  });
