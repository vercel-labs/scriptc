import { defineConfig } from "@playwright/test";

const url = process.env.SCRIPTC_DOCS_URL ?? "http://127.0.0.1:3108";

export default defineConfig({
  testDir: "../tests/browser",
  testMatch: process.env.SCRIPTC_DOCS_BENCH === "1" ? "compatibility.bench.ts" : "compatibility.test.ts",
  outputDir: "node_modules/.cache/compatibility-browser",
  workers: 1,
  retries: 0,
  reporter: "line",
  use: {
    baseURL: url,
    viewport: { width: 1440, height: 1000 },
    launchOptions: process.env.SCRIPTC_BROWSER_PATH ? { executablePath: process.env.SCRIPTC_BROWSER_PATH } : {},
  },
  webServer: process.env.SCRIPTC_DOCS_URL ? undefined : {
    command: "node node_modules/next/dist/bin/next start --port 3108",
    url,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
