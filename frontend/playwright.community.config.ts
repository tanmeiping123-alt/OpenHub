import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "community-live.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  reporter: "list",
  outputDir: `${process.env.LOCALAPPDATA ?? ".."}/PromptMasterAI/community-e2e-results`,
  use: {
    baseURL: "http://127.0.0.1:3107",
    actionTimeout: 15000,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
});
