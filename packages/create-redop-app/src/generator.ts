import chalk from "chalk";
import { execa } from "execa";
import ora from "ora";
import { writeGeneratedFiles } from "./files"; // Re-use your existing logic
import { buildFiles } from "./templates"; // Re-use your template rendering
import type { ResolvedOptions } from "./types";

export async function generateProject(options: ResolvedOptions) {
  const spinner = ora("Creating your redop app...").start();

  // Inside generateProject function
  if (process.env.NODE_ENV === "test") {
    spinner.info("Skipping install in test mode");
  } else {
    spinner.text = `${options.packageManager} installing dependencies...`;
    await execa(options.packageManager, ["install"], {
      cwd: options.targetDir,
    });
  }

  try {
    // 1. Generate and write files
    const files = buildFiles(options); // Adapt templates.ts if needed
    await writeGeneratedFiles(options.targetDir, files);

    // 2. Install dependencies
    spinner.text = `${options.packageManager} installing dependencies...`;
    await execa(options.packageManager, ["install"], {
      cwd: options.targetDir,
      stdio: "inherit", // This shows the bun progress bar in the terminal
    });

    spinner.succeed(chalk.green("Your redop app is ready"));

    // 3. Output next steps
    console.log("\nNext steps:");
    console.log(chalk.cyan(`  cd ${options.appName}`));
    console.log(chalk.cyan(`  ${options.packageManager} dev`));

    console.log("\nTo learn more about redop:");
    console.log(
      "  - Read the documentation at https://redop.useagents.site/docs"
    );
  } catch (error) {
    spinner.fail("Failed to create project");
    throw error;
  }
}
