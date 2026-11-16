import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "./fixtures";
import { MODEL_CATALOG } from "../src/lib/model-catalog";

const versionId = "skv_11111111-1111-4111-8111-111111111111";
const skill = {
  versionId,
  name: "Reference methods",
  description: "Relevant methods for editing the task",
  source: { kind: "OFFLINE" },
  manifestSha256: "a".repeat(64),
  warnings: [],
  publicationKind: null,
  submissionStatus: null,
  reviewNote: null,
};
test.beforeEach(async ({ page, testAccount }) => {
  await page.route("**/api/ai/**", (r) => r.abort());
  await page.route("**/api/models", (r) =>
    r.fulfill({
      json: {
        models: MODEL_CATALOG.map((m) => ({
          key: m.key,
          configured: true,
          maxOutputTokens: 1200,
          timeoutMs: 30000,
        })),
      },
    }),
  );
  await page.route("**/api/skills/library**", (r) =>
    r.fulfill({
      json: {
        user: { id: testAccount.id, email: testAccount.email, role: "USER" },
        library: [],
        personal: [skill],
        pending: [],
        history: [],
        totals: { library: 0, personal: 1, pending: 0, history: 0 },
        available: 1,
        page: 1,
        pageSize: 25,
      },
    }),
  );
});

test("library selects a reference for the existing generation task without inserting its text", async ({
  page,
}) => {
  await page.goto("/en/app/generate");
  await page
    .getByLabel("What do you want the AI to do?", { exact: true })
    .fill("Keep this unsent task and its constraints");
  await page.getByRole("button", { name: "Adjust", exact: true }).click();
  await page.getByRole("link", { name: "Browse or add Skills" }).click();
  await page.getByRole("button", { name: "My imports (1)" }).click();
  await page.getByRole("button", { name: "Use for this generation / optimization" }).click();
  await expect(page).toHaveURL(/\/en\/app\/generate$/);
  await expect(page.getByLabel("What do you want the AI to do?", { exact: true })).toHaveValue(
    "Keep this unsent task and its constraints",
  );
  await page.getByRole("button", { name: "Adjust", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Select manually", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /Reference methods/ })).toBeChecked();
  await expect(page.getByLabel("Task goal and explicit constraints")).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "Adjust", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Select manually", exact: true })).toBeChecked();
});

test("library returns a chosen private reference to the original optimization", async ({
  page,
}) => {
  await page.goto("/en/app/prompts/prm_writing_course_01/optimize");
  await page.getByRole("button", { name: "Adjust", exact: true }).click();
  await page.getByRole("link", { name: "Browse or add Skills" }).click();
  await expect(page).toHaveURL(/taskReturn=/);
  await page.getByRole("button", { name: "My imports (1)" }).click();
  await page.getByRole("button", { name: "Use for this generation / optimization" }).click();
  await expect(page).toHaveURL(/\/en\/app\/prompts\/prm_writing_course_01\/optimize$/);
  await page.getByRole("button", { name: "Adjust", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Select manually", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /Reference methods/ })).toBeChecked();
  await expect(page.getByLabel("Task goal and explicit constraints")).toHaveCount(0);
});

test("task adjustments fit phones and landscape with enlarged text", async ({ page }) => {
  const evidence = path.join(
    process.env.LOCALAPPDATA ?? "..",
    "PromptMasterAI",
    "skills-on-demand",
  );
  await mkdir(evidence, { recursive: true });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const viewport of [
    { width: 375, height: 812 },
    { width: 812, height: 375 },
    { width: 1440, height: 1000 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/zh-CN/app/generate");
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "20px";
    });
    const region = page.getByRole("region", { name: "本次任务的 Skills" });
    await region.getByRole("button", { name: "调整", exact: true }).click();
    await region.getByRole("radio", { name: "手动选择", exact: true }).check();
    await region.getByRole("checkbox", { name: /Reference methods/ }).check();
    await expect(region.getByText("仅你可用", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: path.join(evidence, `task-${viewport.width}.png`),
      fullPage: true,
    });
  }
  expect(errors).toEqual([]);
});
