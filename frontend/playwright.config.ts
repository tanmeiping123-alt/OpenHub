import { defineConfig, devices } from "@playwright/test";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

export default defineConfig({
  testDir: "./tests",
  // Tests use disposable authenticated accounts; keep database writes ordered.
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  // Keep traces and failure snapshots outside the Next.js project tree so
  // development-mode file watching cannot treat test artifacts as app edits.
  outputDir: process.env.LOCALAPPDATA
    ? `${process.env.LOCALAPPDATA}/PromptMasterAI/playwright-results`
    : "../.promptmaster-playwright-results",
  use: { baseURL: "http://127.0.0.1:3000", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1",
    url: "http://127.0.0.1:3000/en",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
