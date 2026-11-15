// Builds dist/claude-youtube.mcpb: bundles src/server.mjs into one file and packs it.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

fs.rmSync("build", { recursive: true, force: true });
fs.mkdirSync("build/server", { recursive: true });
await build({
  entryPoints: ["src/server.mjs"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: "build/server/index.cjs",
  logLevel: "warning",
});
fs.copyFileSync("manifest.json", "build/manifest.json");
if (fs.existsSync("icon.png")) fs.copyFileSync("icon.png", "build/icon.png");
fs.mkdirSync("dist", { recursive: true });
execFileSync("npx", ["mcpb", "pack", "build", "dist/claude-youtube.mcpb"], { stdio: "inherit" });
