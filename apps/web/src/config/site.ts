const url =
  process.env.NODE_ENV === "production"
    ? "https://useagents.site"
    : "http://localhost:3000";

export const siteConfig = {
  description:
    "Bun-native TypeScript framework for building typed MCP servers with tools, middleware, hooks, and plugins.",
  name: "Redop",
  ogImage: `${url}/og.png`,
  title: "Redop | Bun-native MCP Framework",
  url,
};

export const SITE_KEYWORDS = [
  // Core product
  "MCP tools",
  "MCP server",
  "tool directory",
  "AI tools",
  "agent tools",

  // Technology
  "Model Context Protocol",
  "MCP",
  "LLM tools",
  "AI agents",
  "agentic AI",

  // Developer audience
  "developer tools",
  "API tools",
  "SDK",
  "TypeScript",
  "Bun",

  // Use case
  "tool search",
  "tool discovery",
  "AI integrations",
  "agent integrations",
  "workflow automation",

  // Brand
  "UseAgents",
  "useagents.dev",
];
