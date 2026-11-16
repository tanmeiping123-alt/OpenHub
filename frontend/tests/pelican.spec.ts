import { expect, test, type Page } from "@playwright/test";
import type { PelicanAdminBatch, PelicanSample } from "../src/lib/pelican-types";

// Explicit UI fixtures only. No supplier or real publication is used by this suite.
const sample: PelicanSample = {
  id: "ui-sample",
  batchId: "ui-batch",
  modelKey: "deepseek-direct",
  modelName: "UI fixture model snapshot",
  provider: "deepseek",
  requestedModel: "ui-fixture-alias",
  resolvedModel: "ui-fixture-response",
  strength: "off",
  maxOutputTokens: 1200,
  reasoningTokenReserve: 0,
  timeoutMs: 30000,
  generatedAt: "2026-11-09T02:00:00Z",
  latencyMs: 1800,
  callStatus: "SUCCEEDED",
  previewStatus: "READY",
  previewReason: null,
  finishReason: "stop",
  rerunOf: null,
  interrupted: false,
  hasThumbnail: true,
  withdrawn: false,
  withdrawnReason: null,
};
const batch: PelicanAdminBatch = {
  id: "ui-batch",
  title: "UI fixture batch",
  challengeVersion: "pelican-svg-v1",
  createdAt: "2026-11-09T01:00:00Z",
  publishedAt: "2026-11-10T01:00:00Z",
  status: "PUBLISHED",
  samples: [sample],
  estimatedCostUsd: 0.03,
  estimatedTokens: 1200,
  budgetFingerprint: "ui-budget",
  canRun: false,
  canPublish: false,
  canDelete: false,
  blockedReason: null,
  runBlock: null,
};
const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP9sAAAAASUVORK5CYII=",
  "base64",
);
async function fixture(page: Page, batches: PelicanAdminBatch[] = [batch]) {
  const actions: string[] = [];
  const controls: { sessionId: string; action: string }[] = [];
  const sessions: string[] = [];
  const unsafe: string[] = [];
  let frames = 0;
  let withdrawn = false;
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      ["api.deepseek.com", "api.siliconflow.cn", "api.siliconflow.com"].includes(url.hostname) ||
      /\/api\/(ai|demo|models)(\/|$)/.test(url.pathname)
    ) {
      unsafe.push(url.pathname);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/pelican")) return route.continue();
    const path = url.pathname;
    if (path.endsWith("/viewer"))
      return route.fulfill({
        json: { role: null },
      });
    if (path.endsWith("/thumbnail"))
      return route.fulfill({ contentType: "image/png", body: image });
    if (path === "/api/pelican/preview" && route.request().method() === "POST") {
      if (withdrawn) return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
      const sessionId = `ui-session-${sessions.length + 1}`;
      sessions.push(sessionId);
      return route.fulfill({
        json: { sessionId, paused: false, expiresAt: "2026-11-10T12:00:00Z" },
      });
    }
    if (path.startsWith("/api/pelican/preview/ui-session-")) {
      if (withdrawn) return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
      if (route.request().method() === "POST") {
        const action = route.request().postDataJSON().action;
        actions.push(action);
        controls.push({ sessionId: path.split("/").at(-1)!, action });
        return route.fulfill({ json: { ok: true } });
      }
      frames++;
      return route.fulfill({ contentType: "image/png", body: image });
    }
    if (path === "/api/pelican/admin") {
      return route.fulfill({ status: 403, json: { error: "ADMIN_REQUIRED" } });
    }
    if (path === "/api/pelican")
      return route.fulfill({
        json: {
          batches: withdrawn ? [] : batches,
          models: [{ key: sample.modelKey, name: sample.modelName }],
          page: 1,
          hasMore: false,
        },
      });
    return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
  });
  return {
    actions,
    controls,
    sessions,
    unsafe,
    frames: () => frames,
    withdraw: () => {
      withdrawn = true;
    },
  };
}
test("anonymous preview controls one session, freezes fetching on pause, and returns keyboard focus", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/zh-CN/pelican");
  const work = page.getByRole("button", { name: /打开作品.*UI fixture model snapshot/ });
  await expect(work).toBeVisible();
  await expect(page.getByText("2026/11/09 10:00:00", { exact: true })).toBeVisible();
  await work.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByAltText("作品真实动画画面")).toBeVisible();
  await dialog.getByRole("button", { name: "暂停骑行" }).click();
  await expect(dialog.getByRole("button", { name: "继续骑行" })).toBeEnabled();
  await page.waitForTimeout(400);
  const frozenFrames = state.frames();
  await page.waitForTimeout(600);
  expect(state.frames()).toBe(frozenFrames);
  await dialog.getByRole("button", { name: "继续骑行" }).click();
  await expect.poll(state.frames).toBeGreaterThan(frozenFrames);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(work).toBeFocused();
  await expect.poll(() => state.actions.filter((a) => a !== "close")).toEqual(["pause", "resume"]);
  const playback = state.controls.filter((c) => c.action !== "close");
  expect(playback[0].sessionId).toBe(playback[1].sessionId);
  await expect
    .poll(() =>
      state.controls
        .filter((c) => c.action === "close")
        .map((c) => c.sessionId)
        .sort(),
    )
    .toEqual([...state.sessions].sort());
  expect(state.unsafe).toEqual([]);
  await expect(page.locator("iframe")).toHaveCount(0);
});
test("desktop history uses artwork rails with visible navigation and a contained preview", async ({
  page,
}, testInfo) => {
  const samples = Array.from({ length: 8 }, (_, index) => ({
    ...sample,
    id: `rail-${index}`,
    generatedAt: `2026-11-${String(9 - index).padStart(2, "0")}T02:00:00Z`,
  }));
  await fixture(page, [{ ...batch, samples }]);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/zh-CN/pelican");
  await expect(page.getByRole("button", { name: "模型历史" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const rail = page.locator(".pelican-rail");
  expect(await rail.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  await page.getByRole("button", { name: "UI fixture model snapshot 向后浏览" }).click();
  await expect.poll(() => rail.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.screenshot({
    path: testInfo.outputPath("pelican-desktop-gallery.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: /打开作品/ })
    .nth(4)
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByAltText("作品真实动画画面")).toBeVisible();
  const rect = await dialog.boundingBox();
  expect(rect!.width).toBeLessThanOrEqual(1440);
  expect(rect!.height).toBeLessThanOrEqual(1000);
  await page.screenshot({ path: testInfo.outputPath("pelican-desktop-preview.png") });
  await dialog.getByRole("button", { name: "关闭预览" }).click();
});

test("withdrawal closes active preview and removes the public listing", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/zh-CN/pelican");
  await page.getByRole("button", { name: /打开作品/ }).click();
  await expect(page.getByRole("dialog").getByAltText("作品真实动画画面")).toBeVisible();
  state.withdraw();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("还没有已发布作品")).toBeVisible();
  expect(state.unsafe).toEqual([]);
});
test("unauthorized management does not request privileged records", async ({ page }) => {
  await fixture(page);
  const privateCalls: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/pelican/admin")) privateCalls.push(request.url());
  });
  await page.goto("/zh-CN/pelican/manage");
  await expect(page).toHaveURL(/\/zh-CN\/login\?next=/);
  expect(privateCalls).toEqual([]);
});
test("batch switching keeps comparison within one batch and preserves all batch choices", async ({
  page,
}) => {
  const older = {
    ...batch,
    id: "ui-older-batch",
    title: "UI fixture older batch",
    samples: [
      {
        ...sample,
        id: "ui-older-sample",
        batchId: "ui-older-batch",
        modelName: "UI fixture older model snapshot",
      },
    ],
  };
  const state = await fixture(page, [batch, older]);
  await page.goto("/zh-CN/pelican");
  await expect(
    page.getByRole("button", { name: /打开作品.*UI fixture model snapshot/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "本期对比" }).click();
  await expect(
    page.getByRole("button", { name: /打开作品.*UI fixture older model snapshot/ }),
  ).toHaveCount(0);
  await page.getByLabel("选择批次").selectOption("ui-older-batch");
  await expect(
    page.getByRole("button", { name: /打开作品.*UI fixture older model snapshot/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /打开作品.*UI fixture model snapshot/ }),
  ).toHaveCount(0);
  await expect(page.getByLabel("选择批次").locator("option")).toHaveCount(2);
  await page.getByLabel("选择批次").selectOption("ui-batch");
  await expect(
    page.getByRole("button", { name: /打开作品.*UI fixture model snapshot/ }),
  ).toBeVisible();
  expect(state.actions).toEqual([]);
  expect(state.unsafe).toEqual([]);
});
