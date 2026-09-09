import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const pluginRoot = resolve(workspaceRoot, "plugins/aimd-reader");

describe("plugin MCP launch configuration", () => {
  it("resolves the packaged server relative to the plugin root", () => {
    const configPath = resolve(pluginRoot, ".mcp.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const server = config.mcpServers["aimd-reader"];

    expect(server).toEqual({
      command: "node",
      cwd: ".",
      args: ["dist/server.mjs"],
    });
    expect(JSON.stringify(server)).not.toContain("${");

    const launchPath = resolve(dirname(configPath), server.cwd, server.args[0]);
    expect(relative(pluginRoot, launchPath)).toBe(join("dist", "server.mjs"));
  });
});

describe("plugin cache compatibility", () => {
  it("does not use SemVer build metadata in the cache key", () => {
    const manifestPath = resolve(pluginRoot, ".codex-plugin/plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    expect(manifest.version).not.toContain("+");
  });
});
