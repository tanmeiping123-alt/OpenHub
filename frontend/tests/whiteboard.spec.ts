import { test, expect } from "./fixtures";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const evidence = path.join(process.env.LOCALAPPDATA ?? "..", "PromptMasterAI", "whiteboard-review");

test("whiteboard is available inside the workspace and navigation follows function", async ({
  page,
}) => {
  await page.goto("/zh-CN/app/whiteboard");
  await expect(
    page
      .frameLocator('iframe[title="Excalidraw 白板"]')
      .getByRole("heading", { name: "Excalidraw 白板", exact: true }),
  ).toBeVisible();
  const sidebar = page.getByRole("complementary", { name: "工作区导航" });
  await expect(sidebar.locator(".sidebar-label")).toHaveCount(0);
  await expect(sidebar.locator("nav .nav-link")).toHaveText([
    "工作台",
    "生成 Prompt",
    "Excalidraw 白板",
    "我的 Prompt",
    "Skills 管理",
    "版本历史",
    "模型试跑",
    "评估报告",
    "鹈鹕测智",
    "Open Prompt",
  ]);
  await expect(sidebar.getByRole("link", { name: "Excalidraw 白板", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(
    page.frameLocator('iframe[title="Excalidraw 白板"]').locator(".excalidraw canvas").first(),
  ).toBeVisible();
  await expect(page.locator(".whiteboard-status")).toHaveCount(0);
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: path.join(evidence, "desktop.png"), fullPage: true });
});

test.skip("mobile navigation exposes the whiteboard without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/zh-CN/app");
  await page.getByRole("button", { name: "更多导航", exact: true }).click();
  await page
    .getByRole("dialog", { name: "全部导航" })
    .getByRole("link", { name: "Excalidraw 白板", exact: true })
    .click();
  await expect(page).toHaveURL(/\/zh-CN\/app\/whiteboard$/);
  await expect(
    page.frameLocator('iframe[title="Excalidraw 白板"]').locator(".excalidraw canvas").first(),
  ).toBeVisible();
  await expect(page.locator(".whiteboard-status")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: path.join(evidence, "mobile.png"), fullPage: true });
});

test("drawings survive refresh and can be exported and reopened without external requests", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  const external: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1(?::|\/))/, (route) => {
    external.push(route.request().url());
    return route.abort();
  });
  // Exercise the real browser download/input fallback used without native pickers.
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, "showOpenFilePicker");
    Reflect.deleteProperty(window, "showSaveFilePicker");
  });
  const current = await (await context.request.get("/api/whiteboard")).json();
  expect(
    (
      await context.request.put("/api/whiteboard", {
        headers: { origin: "http://127.0.0.1:3000" },
        data: {
          ownerId: current.ownerId,
          revision: current.revision,
          scene: { elements: [], appState: {}, files: {} },
          libraryItems: [],
        },
      })
    ).ok(),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/zh-CN/app/whiteboard");
  const board = page.frameLocator('iframe[title="Excalidraw 白板"]');
  const canvas = board.locator("canvas.interactive");
  await expect(canvas).toBeVisible();
  await board.getByRole("button", { name: "矩形", exact: true }).click();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 330, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 570, box.y + 340, { steps: 10 });
  await page.mouse.up();
  await board.getByRole("button", { name: "文字", exact: true }).click();
  await page.mouse.click(box.x + 350, box.y + 400);
  await page.keyboard.insertText("白板模块验证");
  await page.keyboard.press("Escape");
  const stored = async () =>
    (await (await context.request.get("/api/whiteboard")).json()).scene.elements;
  await expect
    .poll(async () => (await stored()).filter((e: { isDeleted: boolean }) => !e.isDeleted).length)
    .toBe(2);
  await page.reload();
  await expect(canvas).toBeVisible();
  expect((await stored()).some((e: { text?: string }) => e.text === "白板模块验证")).toBe(true);
  await canvas.click({ position: { x: 700, y: 450 } });
  const downloadEvent = page.waitForEvent("download");
  await page.keyboard.press("Control+Shift+s");
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/\.excalidraw$/);
  const file = (await download.path())!;
  const exported = JSON.parse(await readFile(file, "utf8"));
  expect(exported.type).toBe("excalidraw");
  expect(exported.elements).toHaveLength(2);
  expect(exported.elements.some((e: { text?: string }) => e.text === "白板模块验证")).toBe(true);
  const saved = await (await context.request.get("/api/whiteboard")).json();
  expect(
    (
      await context.request.put("/api/whiteboard", {
        headers: { origin: "http://127.0.0.1:3000" },
        data: {
          ownerId: saved.ownerId,
          revision: saved.revision,
          scene: { elements: [], appState: {}, files: {} },
          libraryItems: [],
        },
      })
    ).ok(),
  ).toBe(true);
  await page.reload();
  await expect(canvas).toBeVisible();
  expect(await stored()).toHaveLength(0);
  const chooserEvent = page.waitForEvent("filechooser");
  await board.getByRole("button", { name: "打开 Ctrl+O", exact: true }).click();
  await (
    await chooserEvent
  ).setFiles({
    name: "roundtrip.excalidraw",
    mimeType: "application/json",
    buffer: await readFile(file),
  });
  await expect
    .poll(async () => (await stored()).filter((e: { isDeleted: boolean }) => !e.isDeleted).length)
    .toBe(2);
  await board.getByTestId("main-menu-trigger").click();
  await expect(board.locator(".dropdown-menu")).not.toContainText(
    /GitHub|Discord|Sign up|Excalidraw\+/,
  );
  await page.keyboard.press("Escape");
  await page.screenshot({ path: path.join(evidence, "drawing.png"), fullPage: true });
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test("English entry works and anonymous workspace access still requires login", async ({
  page,
  context,
}) => {
  await page.goto("/en/app/whiteboard");
  await expect(
    page
      .frameLocator('iframe[title="Excalidraw whiteboard"]')
      .getByRole("heading", { name: "Excalidraw whiteboard", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .frameLocator('iframe[title="Excalidraw whiteboard"]')
      .getByRole("button", { name: "Rectangle", exact: true }),
  ).toBeVisible();
  await context.clearCookies();
  await page.goto("/en/app/whiteboard");
  await expect(page).toHaveURL(/\/en\/login\?.*next=/);
});
