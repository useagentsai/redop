#!/usr/bin/env node
import chalk from "chalk";
import { Command } from "commander";
import packageJson from "../package.json";
import { assertEmptyTargetDir } from "./files";
import { generateProject } from "./generator";
import { runPrompts } from "./prompt";

const program = new Command();

program
  .name("create-redop-app")
  .version(packageJson.version)
  .argument("[dir]", "Target directory")
  .option("-t, --transport <type>", "transport type (http, stdio)")
  .option(
    "-d, --deploy <target>",
    "deployment target (railway, fly-io, vercel, none)"
  )
  .action(async (dir, options) => {
    console.log(chalk.cyan(`${packageJson.name}@${packageJson.version}`));

    // 1. Pass the 'dir' and 'options' into runPrompts.
    // This allows the prompt logic to skip questions if the user
    // already provided flags like --transport or --deploy.
    const config = await runPrompts(dir, options);

    // 2. BUG FIX: Use 'config.targetDir' instead of 'options.targetDir'.
    // In Commander, 'options' only contains flags (-t, -d).
    // The actual path comes from your prompt result.
    await assertEmptyTargetDir(config.targetDir);

    // 3. LOGIC FIX: The generator should use the final config.
    // In your original code, the 'if (options.deploy)' block did nothing
    // because it didn't update the 'config' object passed to the generator.
    await generateProject(config);
  });

program.parse(process.argv);
