import path from "node:path";
import * as p from "@clack/prompts";
import chalk from "chalk";
import {
  DEPLOY_TARGETS,
  type DeployTarget,
  type ResolvedOptions,
  TRANSPORTS,
  type Transport,
} from "./types";

/**
 * Runs the interactive CLI prompts to gather project configuration.
 * @param initialName - The default name or name provided via argument.
 * @param flags - Command line options provided (e.g., via Commander).
 */
export async function runPrompts(
  initialName?: string,
  flags?: { transport?: string; deploy?: string }
): Promise<ResolvedOptions> {
  const project = await p.group(
    {
      name: () =>
        p.text({
          message: "What is your project named?",
          placeholder: initialName || "my-redop-app",
          initialValue: initialName || "my-redop-app",
          validate: (value) => {
            if (value.trim().length === 0) {
              return "Project name cannot be empty";
            }
          },
        }),
      template: () =>
        p.select({
          message: "Select a template:",
          options: [
            { value: "standard", label: "Default (Standard MCP server)" },
          ],
        }),
      packageManager: () =>
        p.select({
          message: "Select a package manager:",
          initialValue: "bun",
          options: [
            { value: "bun", label: "bun" },
            { value: "npm", label: "npm" },
          ],
        }),
      transport: () => {
        // Skip prompt if flag is provided and valid
        if (
          flags?.transport &&
          TRANSPORTS.includes(flags.transport as Transport)
        ) {
          return Promise.resolve(flags.transport as Transport);
        }
        return p.select({
          message: "Select the transport you want to use:",
          options: [
            { value: "http", label: "HTTP (runs on a server)" },
            { value: "stdio", label: "Stdio (local pipe)" },
          ],
        });
      },
      deploy: ({ results }) => {
        // 1. Skip if transport is stdio (local only)
        if (results.transport === "stdio") {
          return Promise.resolve("none" as DeployTarget);
        }
        // 2. Skip if flag is provided and valid
        if (
          flags?.deploy &&
          DEPLOY_TARGETS.includes(flags.deploy as DeployTarget)
        ) {
          return Promise.resolve(flags.deploy as DeployTarget);
        }

        return p.select({
          message: "Select a deployment target:",
          options: [
            { value: "none", label: "None (Manual)" },
            { value: "railway", label: "Railway" },
            { value: "fly-io", label: "Fly.io" },
            { value: "vercel", label: "Vercel" },
          ],
        });
      },
      components: () =>
        p.multiselect({
          message: "Select components to initialize:",
          options: [{ value: "tools", label: "Tools", hint: "recommended" }],
        }),
      confirm: ({ results }) =>
        p.confirm({
          message: `Creating a new redop app in ${chalk.cyan(
            path.resolve(process.cwd(), results.name as string)
          )}. Ok to continue?`,
        }),
    },
    {
      onCancel: () => {
        p.cancel("Operation cancelled.");
        process.exit(0);
      },
    }
  );

  if (!project.confirm) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }

  return {
    appName: project.name as string,
    targetDir: path.resolve(process.cwd(), project.name as string),
    transport: project.transport as Transport,
    packageManager: project.packageManager as "bun" | "npm",
    template: project.template as string,
    components: project.components as string[],
    deploy: (project.deploy as DeployTarget) || "none",
  };
}
