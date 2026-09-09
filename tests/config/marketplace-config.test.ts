import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("repository-local Codex marketplace", () => {
  it("discovers AIMD Reader from a portable repo-relative source", async () => {
    const marketplace = JSON.parse(
      await readFile(resolve(workspaceRoot, ".agents/plugins/marketplace.json"), "utf8"),
    ) as {
      name: string;
      interface: { displayName: string };
      plugins: Array<{
        name: string;
        source: { source: string; path: string };
        policy: { installation: string; authentication: string; products: string[] };
        category: string;
      }>;
    };
    const manifest = JSON.parse(
      await readFile(resolve(workspaceRoot, "plugins/aimd-reader/.codex-plugin/plugin.json"), "utf8"),
    ) as { name: string };

    expect(marketplace).toEqual({
      name: "aimd-local",
      interface: { displayName: "AIMD Local" },
      plugins: [
        {
          name: "aimd-reader",
          source: { source: "local", path: "./plugins/aimd-reader" },
          policy: {
            installation: "AVAILABLE",
            authentication: "ON_INSTALL",
            products: ["CODEX"],
          },
          category: "Developer Tools",
        },
      ],
    });
    expect(marketplace.plugins[0]?.name).toBe(manifest.name);
    expect(resolve(workspaceRoot, marketplace.plugins[0]!.source.path))
      .toBe(resolve(workspaceRoot, "plugins/aimd-reader"));
  });
});
