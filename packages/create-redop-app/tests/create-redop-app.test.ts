import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { exists, rm } from "node:fs/promises";
import path from "node:path";
import { generateProject } from "../src/generator";
import type { ResolvedOptions } from "../src/types";

const TEST_DIR = path.resolve(process.cwd(), "temp-test-app");

describe("Generator Logic", () => {
  // Clean up before and after tests
  const cleanup = async () => {
    if (await exists(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
  };

  beforeAll(cleanup);
  afterAll(cleanup);

  test("should generate core files for a standard http app", async () => {
    const options: ResolvedOptions = {
      appName: "test-app",
      targetDir: TEST_DIR,
      transport: "http",
      packageManager: "bun",
      template: "standard",
      components: ["tools"],
      deploy: "none",
    };

    // We skip the 'execa' install part in tests to keep them fast
    // You can mock the install or just test the file generation
    await generateProject(options);

    // Assert files exist
    expect(await exists(path.join(TEST_DIR, "package.json"))).toBe(true);
    expect(await exists(path.join(TEST_DIR, "src/index.ts"))).toBe(true);
    expect(await exists(path.join(TEST_DIR, "tsconfig.json"))).toBe(true);
  });
});
