import { test, expect } from "./fixtures";
import path from "node:path";

test("desktop chrome is compact with one creation entry and a left aligned collapse label", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/zh-CN/app");
  const sidebar = page.getByRole("complementary", { name: "工作区导航" });
  await expect(sidebar).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "新建 Prompt", exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole("link", { name: "生成 Prompt", exact: true })).toHaveCount(1);
  const toggle = sidebar.getByRole("button", { name: "收起导航", exact: true });
  await expect(toggle).toHaveText("收起");
  const icon = (await toggle.locator("svg").boundingBox())!;
  const text = (await toggle.locator("span").boundingBox())!;
  expect(text.x).toBeGreaterThan(icon.x + icon.width);
  expect(Math.abs(text.y + text.height / 2 - (icon.y + icon.height / 2))).toBeLessThan(3);
  expect((await toggle.boundingBox())!.x - (await sidebar.boundingBox())!.x).toBeLessThan(25);
  expect((await page.locator(".topbar").boundingBox())!.height).toBeLessThanOrEqual(54);
  expect(await sidebar.evaluate((el) => getComputedStyle(el).scrollbarWidth)).toBe("none");
  await page.goto("/en/app");
  await expect(page.getByRole("button", { name: "Collapse navigation", exact: true })).toHaveText(
    "Collapse",
  );
});

test("navigation keeps its shell and account controls mounted while the session is rechecked", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/zh-CN/app");
  const sidebar = page.getByRole("complementary", { name: "工作区导航" });
  await expect(sidebar).toBeVisible();
  await sidebar.locator(".sidebar-account > summary").click();
  await page.evaluate(() => {
    const nav = document.querySelector(".sidebar")!;
    const changes = { removed: false, checks: 0 };
    (window as typeof window & { navChanges?: typeof changes }).navChanges = changes;
    new MutationObserver(() => {
      if (!nav.isConnected) changes.removed = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
  await page.route("**/api/auth/session", async (route) => {
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({ response });
  });
  for (const [name, url] of [
    ["我的 Prompt", "/app/library"],
    ["生成 Prompt", "/app/generate"],
    ["版本历史", "/app/history"],
    ["工作台", "/app"],
  ]) {
    const checked = page.waitForResponse((response) =>
      response.url().endsWith("/api/auth/session"),
    );
    await sidebar.getByRole("link", { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(url + "$"));
    await expect(sidebar).toBeVisible();
    await checked;
    await expect(sidebar.locator(".sidebar-account")).toHaveAttribute("open", "");
  }
  expect(
    await page.evaluate(
      () => (window as typeof window & { navChanges?: { removed: boolean } }).navChanges?.removed,
    ),
  ).toBe(false);
  await expect(page.getByText("正在验证登录状态…", { exact: true })).toHaveCount(0);
});

test("sidebar collapses to accessible icons, persists on navigation and reload, and expands again", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/zh-CN/app");
  const sidebar = page.getByRole("complementary", { name: "工作区导航" });
  const expandedWidth = (await sidebar.boundingBox())!.width;
  await sidebar.getByRole("button", { name: "收起导航", exact: true }).click();
  await expect(sidebar.getByRole("button", { name: "展开导航", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect((await sidebar.boundingBox())!.width).toBeLessThan(expandedWidth / 2);
  await page.screenshot({
    path: path.join(process.env.LOCALAPPDATA ?? "..", "PromptMasterAI", "navigation-collapsed.png"),
  });
  await sidebar.getByRole("link", { name: "我的 Prompt", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/library$/);
  await expect(sidebar.getByRole("button", { name: "展开导航", exact: true })).toBeVisible();
  await page.reload();
  await expect(sidebar.getByRole("button", { name: "展开导航", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "设置", exact: true })).toBeVisible();
  await sidebar.getByRole("link", { name: "设置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
  await sidebar.getByRole("button", { name: "展开导航", exact: true }).click();
  await expect(sidebar.getByRole("button", { name: "收起导航", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(page.getByText("让好想法被看见。", { exact: true })).toHaveCount(0);
  await expect(page.getByText("本地工作区", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: path.join(process.env.LOCALAPPDATA ?? "..", "PromptMasterAI", "navigation-expanded.png"),
  });
  expect(errors).toEqual([]);
});

test("unavailable session on navigation still locks the workspace and retry recovers", async ({
  page,
}) => {
  await page.goto("/en/app");
  const sidebar = page.locator(".sidebar");
  await expect(sidebar).toBeVisible();
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ status: 503, json: { error: "ACCOUNT_SERVICE_UNAVAILABLE" } }),
  );
  await sidebar.getByRole("link", { name: "My Prompts", exact: true }).click();
  await expect(
    page.getByText("Session verification unavailable. Workspace is locked."),
  ).toBeVisible();
  await expect(sidebar).toHaveCount(0);
  await page.unroute("**/api/auth/session");
  await page.getByRole("button", { name: "Retry verification" }).click();
  await expect(sidebar).toBeVisible();
});

test("collapse control remains usable when browser preference writes are blocked", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const originalSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "promptmaster-sidebar-collapsed") throw new DOMException("blocked");
      originalSet.call(this, key, value);
    };
  });
  await page.goto("/en/app");
  await page.getByRole("button", { name: "Collapse navigation", exact: true }).click();
  await expect(page.getByRole("button", { name: "Expand navigation", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Expand navigation", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Collapse navigation", exact: true }),
  ).toBeVisible();
});

test("everyday pages drop duplicate tips while retaining form labels", async ({ page }) => {
  await page.goto("/zh-CN/app/generate");
  await expect(page.getByText("说清你想做的事，把第一版交给 AI。", { exact: true })).toHaveCount(0);
  await expect(page.getByText("消耗模型额度 · 自动保存结果", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("你希望 AI 完成什么？", { exact: true })).toBeVisible();
  await expect(page.getByText("修改设置不会调用模型。", { exact: true })).toHaveCount(0);
  await page.goto("/zh-CN/app/library");
  await expect(
    page.getByText("按用途、标签或收藏查找已保存的 Prompt。", { exact: true }),
  ).toHaveCount(0);
  await page.goto("/zh-CN/app/settings");
  await expect(
    page.getByText("偏好设置应用于当前浏览器标签页中的登录账号。", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Prompt 内容不会自动翻译。", { exact: true })).toHaveCount(0);
});
