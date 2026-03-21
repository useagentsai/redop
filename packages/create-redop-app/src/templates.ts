import type { DeployTarget, GeneratedFile, ResolvedOptions } from "./types";

function toPackageName(name: string) {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, "-")
      .replace(/^-+|-+$/g, "") || "redop-app"
  );
}

function toServerName(name: string) {
  return toPackageName(name);
}

function renderPackageJson(options: ResolvedOptions) {
  return JSON.stringify(
    {
      name: toPackageName(options.appName),
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: {
        build: "bun build ./src/index.ts --outdir ./dist --target node",
        dev: "bun run src/index.ts",
        start:
          options.transport === "http"
            ? "bun run src/index.ts"
            : "bun run src/index.ts",
        typecheck: "tsc --noEmit",
      },
      dependencies: {
        "@useagents/redop": "latest",
        zod: "latest",
      },
      devDependencies: {
        "@types/bun": "latest",
        typescript: "latest",
      },
    },
    null,
    2
  );
}

function renderTsconfig() {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "bundler",
        types: ["bun-types"],
        strict: true,
        noUncheckedIndexedAccess: true,
        skipLibCheck: true,
        outDir: "./dist",
      },
      include: ["src/**/*"],
      exclude: ["node_modules", "dist"],
    },
    null,
    2
  );
}

function renderGitignore() {
  return ["node_modules", "dist", ".env", ".DS_Store"].join("\n") + "\n";
}

function renderIndexTs(options: ResolvedOptions) {
  const appHeader = `import { Redop } from "redop";
import { z } from "zod";

const app = new Redop({
  name: "${toServerName(options.appName)}",
  version: "0.1.0",
}).tool("ping", {
  description: "Health check tool",
  input: z.object({
    message: z.string().default("pong"),
  }),
  handler: ({ input }) => ({
    ok: true,
    message: input.message,
    ts: Date.now(),
  }),
});
`;

  if (options.transport === "stdio") {
    return `${appHeader}
app.listen({
  transport: "stdio",
});
`;
  }

  return `${appHeader}
app.listen({
  port: Number(process.env.PORT ?? 3000),
  hostname: "0.0.0.0",
  cors: true,
  onListen: ({ url }) => {
    console.log(\`Redop is running at \${url}\`);
  },
});
`;
}

function renderDockerfile() {
  return `FROM oven/bun:1

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install

COPY . .

EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
`;
}

function renderFlyToml(options: ResolvedOptions) {
  const appName = `${toPackageName(options.appName)}-fly`;
  return `app = "${appName}"

[http_service]
  internal_port = 3000
  force_https = true
  auto_start_machines = true
  auto_stop_machines = "stop"
  min_machines_running = 1

  [[http_service.checks]]
    interval = "15s"
    timeout = "5s"
    grace_period = "10s"
    method = "GET"
    path = "/mcp/health"
`;
}

function renderVercelJson() {
  return JSON.stringify(
    {
      $schema: "https://openapi.vercel.sh/vercel.json",
      bunVersion: "1.x",
    },
    null,
    2
  );
}

function renderWarnings(options: ResolvedOptions) {
  const warnings: string[] = [];

  if (options.transport === "stdio" && options.deploy !== "none") {
    warnings.push(
      `This starter uses stdio, but the "${options.deploy}" preset is not the normal hosted production shape for stdio apps.`
    );
  }

  if (options.transport === "http" && options.deploy === "vercel") {
    warnings.push(
      "Vercel is not a drop-in host for the default long-running Redop HTTP server shape."
    );
  }

  return warnings;
}

function deploySection(deploy: DeployTarget) {
  switch (deploy) {
    case "none":
      return `## Deploy on Bun runtime

Run this app as a Bun HTTP or stdio service. For HTTP, bind to \`0.0.0.0\` and read \`PORT\` from the environment.`;
    case "railway":
      return `## Deploy on Railway

Use Railway as a long-running Bun service. Set your start command to \`bun run src/index.ts\` and point health checks at \`/mcp/health\` for HTTP apps.`;
    case "fly-io":
      return `## Deploy on Fly.io

This starter includes a Dockerfile and \`fly.toml\`. Deploy with \`fly launch\` and \`fly deploy\`.`;
    case "vercel":
      return `## Deploy on Vercel

This preset adds \`vercel.json\`, but Vercel uses a function model. Treat this as a starting point, not a drop-in match for the default Redop server shape.`;
    default:
      return `## Deploy

No deploy files were generated for this starter.`;
  }
}

function renderReadme(options: ResolvedOptions) {
  const warnings = renderWarnings(options);
  const warningBlock =
    warnings.length === 0
      ? ""
      : `## Warnings

${warnings.map((warning) => `- ${warning}`).join("\n")}

`;

  const transportBlock =
    options.transport === "http"
      ? `## Run

\`\`\`sh
bun install
bun run src/index.ts
\`\`\`

Your server will listen on \`PORT\` or fall back to \`3000\`.

Check health:

\`\`\`sh
curl http://localhost:3000/mcp/health
\`\`\``
      : `## Run

\`\`\`sh
bun install
bun run src/index.ts
\`\`\`

This starter uses stdio transport for local MCP host integrations.`;

  return `# ${options.appName}

A Redop starter app generated by \`create-redop-app\`.

- transport: \`${options.transport}\`
- deploy target: \`${options.deploy}\`

${warningBlock}${transportBlock}

${deploySection(options.deploy)}
`;
}

export function buildFiles(options: ResolvedOptions): GeneratedFile[] {
  const files: GeneratedFile[] = [
    { path: ".gitignore", content: renderGitignore() },
    { path: "README.md", content: renderReadme(options) },
    { path: "package.json", content: renderPackageJson(options) + "\n" },
    { path: "tsconfig.json", content: renderTsconfig() + "\n" },
    { path: "src/index.ts", content: renderIndexTs(options) },
  ];

  if (options.deploy === "fly-io") {
    files.push(
      { path: "Dockerfile", content: renderDockerfile() },
      { path: "fly.toml", content: renderFlyToml(options) }
    );
  }

  if (options.deploy === "vercel") {
    files.push({ path: "vercel.json", content: renderVercelJson() + "\n" });
  }

  return files;
}
