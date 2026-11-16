import { test, expect } from "./fixtures";
import { createInitialState } from "../src/lib/fixtures";
import path from "node:path";

const promptId = "prm_search_own";
const currentContent = "软删除方案：新增 deleted_at，恢复操作须验证权限。";
const oldContent = "Archive recovery historical baseline only.";

test("inline search pushes content without a modal or blocking workspace controls", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/zh-CN/app");
  const search = page.getByRole("searchbox", { name: "搜索 Prompt 和历史记录", exact: true });
  await expect(search).toBeVisible();
  await expect(page.locator(".topbar kbd")).toHaveText("CTRL＋K");
  const heading = page.locator("h1").first();
  const before = (await heading.boundingBox())!.y;
  await search.fill("恢复");
  const panel = page.getByRole("region", { name: "搜索工作区", exact: true });
  await expect(panel).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await heading.boundingBox())!.y).toBeGreaterThan(before);
  expect(await page.locator("body").evaluate((el) => getComputedStyle(el).overflow)).not.toBe(
    "hidden",
  );
  await panel.locator(".workspace-search-result").click();
  await page.screenshot({ path: testInfo.outputPath("inline-search-desktop.png") });
  await page.screenshot({
    path: path.join(
      process.env.LOCALAPPDATA ?? "..",
      "PromptMasterAI",
      "inline-search-desktop.png",
    ),
  });
  await page
    .getByRole("complementary")
    .getByRole("link", { name: "我的 Prompt", exact: true })
    .click();
  await expect(page).toHaveURL(/\/app\/library$/);
  await expect(panel).toHaveCount(0);
});

test("search remains visible from a scrolled page and reopening returns focus to the input", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/zh-CN/app/settings");
  const search = page.getByRole("searchbox", { name: "搜索 Prompt 和历史记录", exact: true });
  await expect(search).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.keyboard.press("Control+k");
  const panel = page.getByRole("region", { name: "搜索工作区", exact: true });
  await expect(panel).toBeInViewport();
  expect((await panel.boundingBox())!.y).toBeGreaterThanOrEqual(52);
  await search.fill("恢复");
  await panel.locator(".workspace-search-result").click();
  await expect(panel.getByRole("region", { name: "只读预览" })).toBeFocused();
  await page.getByRole("complementary").getByRole("button", { name: "收起导航" }).click();
  await expect(panel).toHaveCount(0);
  await page.keyboard.press("Control+k");
  await expect(search).toBeFocused();
  await expect(panel.getByRole("region", { name: "只读预览" })).toHaveCount(0);
  await search.fill("Archive");
  await expect(panel.locator(".workspace-search-result")).toHaveCount(1);
});

test.beforeEach(async ({ page }) => {
  await page.route("**/api/ai/**", (r) =>
    r.fulfill({ status: 503, json: { error: "NO_PAID_CALLS" } }),
  );
  const initial = createInitialState();
  const versions = [
    {
      id: "ver_search_current",
      promptId,
      number: 2,
      title: "任务软删除与恢复 Prompt",
      content: currentContent,
      createdAt: "2026-11-06T00:00:00Z",
      source: "MANUAL_EDIT",
      createdBy: "fixture",
    },
    {
      id: "ver_search_old",
      promptId,
      number: 1,
      title: "Archive plan",
      content: oldContent,
      createdAt: "2026-11-05T00:00:00Z",
      source: "MANUAL_EDIT",
      createdBy: "fixture",
    },
  ];
  await page.route("**/api/demo/snapshot", (r) =>
    r.fulfill({
      json: {
        ...initial,
        prompts: [
          {
            id: promptId,
            title: versions[0].title,
            taskType: "Coding",
            currentVersionId: versions[0].id,
            kind: "PERSONAL_PROMPT",
            description: "Planning recovery tasks",
            favorite: false,
          },
        ],
        versions,
        history: versions.map((v) => ({
          id: `history_${v.id}`,
          promptId,
          versionId: v.id,
          source: v.source,
          createdAt: v.createdAt,
        })),
        reports: [],
        favorites: [],
        libraryPromptIds: [promptId],
        playgroundRuns: [],
        liveAdvice: [],
      },
    }),
  );
});

test("top search supports Chinese keywords, typo matching, preview and exact historic editing without server writes", async ({
  page,
}) => {
  await page.goto("/zh-CN/app");
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET") writes.push(r.url());
  });
  await page.getByRole("searchbox", { name: "搜索 Prompt 和历史记录", exact: true }).click();
  const dialog = page.getByRole("region", { name: "搜索工作区", exact: true });
  const search = page.getByRole("searchbox", { name: "搜索 Prompt 和历史记录", exact: true });
  await expect(search).toBeFocused();
  await search.fill("恢复 软删除");
  await expect(dialog.locator(".workspace-search-result")).toHaveCount(1);
  await search.fill("promt");
  await expect(dialog.locator(".workspace-search-result")).toHaveCount(1);
  await search.fill("Archive recovery");
  await expect(dialog.locator(".workspace-search-result")).toHaveCount(1);
  await page.keyboard.press("ArrowDown");
  await expect(dialog.locator(".workspace-search-result")).toBeFocused();
  await page.keyboard.press("Enter");
  const preview = dialog.getByRole("region", { name: "只读预览" });
  await expect(preview.locator("pre")).toHaveText(oldContent);
  await preview.getByRole("link", { name: "继续编辑此版本" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/prompts/${promptId}/edit$`));
  await expect(page.getByLabel("Prompt 内容", { exact: true })).toHaveValue(oldContent);
  expect(writes).toEqual([]);
});

test("Ctrl/Cmd K, clear, empty state, Escape and outside dismissal work", async ({ page }) => {
  await page.goto("/en/app");
  const trigger = page.getByRole("searchbox", { name: "Search prompts and history", exact: true });
  await expect(trigger).toBeVisible();
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("region", { name: "Search your workspace", exact: true });
  const search = page.getByRole("searchbox", { name: "Search prompts and history", exact: true });
  await search.fill("private foreign unmatched");
  await expect(dialog.getByText("No matches found", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await expect(dialog.locator(".workspace-search-result")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Meta+k");
  await expect(dialog).toBeVisible();
  await page.mouse.click(2, 2);
  await expect(dialog).not.toBeVisible();
});

test("search preserves unsaved draft including a deletion when replacement is cancelled", async ({
  page,
}) => {
  await page.goto(`/zh-CN/app/prompts/${promptId}/edit`);
  const editor = page.getByLabel("Prompt 内容", { exact: true });
  await expect(editor).toHaveValue(currentContent);
  await editor.fill("");
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("region", { name: "搜索工作区", exact: true });
  await page.getByRole("searchbox").fill("Archive");
  await dialog.locator(".workspace-search-result").click();
  page.once("dialog", (confirmation) => confirmation.dismiss());
  await dialog.getByRole("link", { name: "继续编辑此版本" }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editor).toHaveValue("");
});

test("IME Enter never selects a result and keyboard focus can leave search", async ({ page }) => {
  await page.goto("/zh-CN/app");
  await expect(
    page.getByRole("searchbox", { name: "搜索 Prompt 和历史记录", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("region", { name: "搜索工作区", exact: true });
  const search = page.getByRole("searchbox");
  await search.fill("恢复");
  await search.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(search).toBeFocused();
  await expect(dialog.getByRole("region", { name: "只读预览" })).toHaveCount(0);
  const mode = page.getByRole("button", { name: /专家模式/ });
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(mode).toBeFocused();
  await expect(dialog).toBeVisible();
  await mode.press("Enter");
  await expect(dialog).toHaveCount(0);
});

test("phone and landscape search stay available without overflow, including enlarged text", async ({
  page,
}, testInfo) => {
  for (const viewport of [
    { width: 375, height: 812 },
    { width: 812, height: 375 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/zh-CN/app");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("searchbox", { name: "搜索 Prompt 和历史记录", exact: true }).click();
    const dialog = page.getByRole("region", { name: "搜索工作区", exact: true });
    await page.getByRole("searchbox").fill("恢复");
    await dialog.locator(".workspace-search-result").click();
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(dialog.getByRole("link", { name: "继续编辑此版本" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`search-${viewport.width}.png`) });
    await page.keyboard.press("Escape");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  }
});

test("anonymous and empty-account workspaces do not expose fixture or other-account results", async ({
  page,
  context,
}) => {
  const initial = createInitialState();
  await page.route("**/api/demo/snapshot", (r) =>
    r.fulfill({
      json: {
        ...initial,
        prompts: [],
        versions: [],
        history: [],
        reports: [],
        favorites: [],
        libraryPromptIds: [],
        playgroundRuns: [],
        liveAdvice: [],
      },
    }),
  );
  await page.goto("/zh-CN/app");
  await expect(
    page.getByRole("searchbox", { name: "搜索 Prompt 和历史记录", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Control+k");
  await expect(page.locator(".workspace-search-result")).toHaveCount(0);
  await page.getByRole("searchbox").fill("恢复");
  await expect(page.getByText("没有匹配结果", { exact: true })).toBeVisible();
  await context.clearCookies();
  await page.goto("/zh-CN/login");
  await expect(
    page.getByRole("searchbox", { name: "搜索 Prompt 和历史记录", exact: true }),
  ).toHaveCount(0);
});
