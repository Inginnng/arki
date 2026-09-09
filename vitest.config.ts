import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@aimd/contracts": fileURLToPath(new URL("./packages/contracts/src/index.ts", import.meta.url)),
      "@aimd/reader-core": fileURLToPath(new URL("./packages/reader-core/src/index.ts", import.meta.url)),
      "@aimd/app-server-bridge": fileURLToPath(new URL("./packages/app-server-bridge/src/index.ts", import.meta.url)),
      "@aimd/workspace-server": fileURLToPath(new URL("./packages/workspace-server/src/index.ts", import.meta.url)),
    },
  },
  test: {
    fileParallelism: false,
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["packages/**/*.test.ts", "tests/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "ui",
          environment: "jsdom",
          include: ["apps/**/*.test.ts", "apps/**/*.test.tsx"],
        },
      },
    ],
  },
});
