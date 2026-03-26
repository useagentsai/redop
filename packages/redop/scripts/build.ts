import tailwind from "bun-plugin-tailwind";

async function buildOrExit(label: string, config: Parameters<typeof Bun.build>[0]) {
  const result = await Bun.build(config);

  if (!result.success) {
    for (const log of result.logs) {
      console.error(`[${label}] ${log.message}`);
    }
    process.exit(1);
  }
}

await buildOrExit("server", {
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  target: "node",
  plugins: [tailwind],
});

await buildOrExit("ui", {
  entrypoints: ["./src/ui/index.html"],
  outdir: "./dist/ui",
  target: "browser",
  plugins: [tailwind],
});
