import { defineConfig, devices } from "@playwright/test";
const browserChannel = process.env.ARKI_BROWSER_CHANNEL || "msedge";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    colorScheme: "light",
    locale: "en-US",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop-1280x800",
      use: { ...devices["Desktop Chrome"], channel: browserChannel, viewport: { width: 1280, height: 800 } },
    },
    {
      name: "desktop-1600x1000",
      use: { ...devices["Desktop Chrome HiDPI"], channel: browserChannel, viewport: { width: 1600, height: 1000 } },
    },
  ],
  webServer: {
    command: "pnpm --filter @aimd/reader-ui exec vite --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173/mock.html",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
