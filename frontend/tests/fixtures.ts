import { test as base, expect } from "@playwright/test";
import { createInitialState } from "../src/lib/fixtures";
import { createTestAccount, cleanupTestAccount } from "../scripts/test-account.mjs";

type TestAccount = { id: string; email: string; password: string; token: string };
export const test = base.extend<object, { testAccount: TestAccount }>({
  testAccount: [
    async ({}, provide) => {
      const account = await createTestAccount();
      try {
        await provide(account);
      } finally {
        await cleanupTestAccount(account);
      }
    },
    { scope: "worker" },
  ],
  storageState: async ({ testAccount }, provide) => {
    await provide({
      cookies: [
        {
          name: "pm_session",
          value: testAccount.token,
          domain: "127.0.0.1",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: "Strict",
        },
      ],
      origins: [],
    });
  },
  page: async ({ page }, provide) => {
    // Task planning and execution are explicitly mocked by each live-flow test.
    // A changed UI path must never accidentally dispatch a paid model request.
    await page.route("**/api/skills/workflow**", (route) => route.abort());
    // Historical preview records are browser-only fixtures, never another user's DB data.
    await page.route("**/api/demo/snapshot", async (route) => {
      const response = await route.fetch();
      if (!response.ok()) {
        await route.fulfill({ response });
        return;
      }
      const actual = await response.json();
      const demo = createInitialState();
      for (const key of [
        "prompts",
        "versions",
        "reports",
        "history",
        "libraryPromptIds",
      ] as const) {
        actual[key] = [...demo[key], ...actual[key]];
      }
      await route.fulfill({ response, json: actual });
    });
    try {
      await provide(page);
    } finally {
      // Finish in-flight snapshot interception before the base fixture closes
      // its request context; otherwise fast navigation/registration can race
      // response.json() with disposal and create a false product failure.
      await page.unrouteAll({ behavior: "wait" });
    }
  },
});
export { expect };
