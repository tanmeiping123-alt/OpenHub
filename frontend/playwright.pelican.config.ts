import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "pelican-live.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120000,
  expect: { timeout: 20000 },
  reporter: "list",
  outputDir:
    process.env.PROMPTMASTER_PELICAN_EVIDENCE ??
    `${process.env.LOCALAPPDATA ?? ".."}/PromptMasterAI/pelican-e2e-results`,
  use: {
    baseURL: "http://127.0.0.1:3108",
    actionTimeout: 20000,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
});
