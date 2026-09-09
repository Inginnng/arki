import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function containsTypeScript(path) {
  if (!existsSync(path)) return false;
  return readdirSync(path, { recursive: true, withFileTypes: true }).some(
    (entry) => entry.isFile() && /\.tsx?$/.test(entry.name),
  );
}

const hasInputs = containsTypeScript("src") || existsSync("vite.config.ts");

if (!hasInputs) {
  console.log("No TypeScript inputs yet; scaffold typecheck skipped.");
  process.exit(0);
}

const compiler = fileURLToPath(
  new URL("../node_modules/typescript/bin/tsc", import.meta.url),
);
// Project references require fresh declaration outputs at package boundaries.
// Build mode creates them from current source instead of trusting stale dist files.
const result = spawnSync(process.execPath, [compiler, "-b", "tsconfig.json"], {
  cwd: process.cwd(),
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
