import { expect, test } from "./fixtures";
import { createInitialState } from "../src/lib/fixtures";

test("library, detail, dashboard and search share saved purposes rather than the legacy type", async ({
  page,
}, testInfo) => {
  const snapshot = createInitialState();
  const prompt = snapshot.prompts.find((p) => snapshot.libraryPromptIds.includes(p.id))!;
  prompt.taskType = "General";
  prompt.descriptor = { purposes: ["analyze", "plan"], tags: ["经营复盘"] };
  await page.route("**/api/demo/snapshot", (r) => r.fulfill({ json: snapshot }));
  await page.goto("/zh-CN/app/library");
  await page.getByLabel("按用途筛选", { exact: true }).selectOption("analyze");
  await page.getByLabel("搜索 Prompt", { exact: true }).fill("经营复盘");
  const card = page.locator("article").first();
  await expect(card.getByText("分析与研究", { exact: true })).toBeVisible();
  await expect(card.getByText("规划与决策", { exact: true })).toBeVisible();
  await page.getByLabel("按用途筛选", { exact: true }).selectOption("plan");
  await expect(card.getByText("经营复盘", { exact: true })).toBeVisible();
  await page.getByLabel("按用途筛选", { exact: true }).selectOption("uncategorized");
  await expect(page.getByText("没有找到 Prompt", { exact: true })).toBeVisible();
  await page.getByLabel("按用途筛选", { exact: true }).selectOption("analyze");
  await card.getByRole("link", { name: "查看详情" }).click();
  await expect(page.getByText("经营复盘", { exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");
  for (const width of [375, 812, 1440]) {
    await page.setViewportSize({ width, height: width === 812 ? 375 : 900 });
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByText("经营复盘", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`metadata-detail-${width}.png`),
      fullPage: true,
    });
  }
  await page.goto("/zh-CN/app");
  await expect(
    page.locator(".recent-prompt").filter({ hasText: "分析与研究、规划与决策" }),
  ).toBeVisible();
  await page.getByRole("searchbox", { name: "搜索 Prompt 和历史记录", exact: true }).click();
  await page
    .getByRole("searchbox", { name: "搜索 Prompt 和历史记录", exact: true })
    .fill("经营复盘");
  await expect(page.locator(".workspace-search-result").first()).toBeVisible();
});

test("using a template keeps its independently saved purposes and tags in the copy request", async ({
  page,
}) => {
  const snapshot = createInitialState();
  const prompt = snapshot.prompts.find(
    (p) => p.kind === "TEMPLATE" && snapshot.libraryPromptIds.includes(p.id),
  )!;
  prompt.descriptor = { purposes: ["understand", "improve"], tags: ["Copied metadata"] };
  await page.route("**/api/demo/snapshot", (r) => r.fulfill({ json: snapshot }));
  let payload: unknown;
  await page.route("**/api/prompts", (r) => {
    payload = r.request().postDataJSON();
    return r.fulfill({ status: 400, json: { error: "TEST_NO_SAVE" } });
  });
  await page.goto("/en/app/library");
  await page.getByLabel("Filter by purpose", { exact: true }).selectOption("understand");
  await page.locator("article").first().getByRole("link", { name: "View details" }).click();
  await page.getByRole("button", { name: "Use template", exact: true }).click();
  await expect.poll(() => payload).toMatchObject({ descriptor: prompt.descriptor });
});

test("manual drafts use the same optional purposes and explicit clearing remains uncategorized", async ({
  page,
}) => {
  await page.goto("/en/app/editor");
  await page.getByLabel("Prompt title", { exact: true }).fill("Metadata manual regression");
  await page.getByLabel("Prompt content", { exact: true }).fill("Translate this sales report");
  await page.getByText("Purposes and tags · optional", { exact: true }).click();
  await page.getByRole("button", { name: "Clear purposes and tags", exact: true }).click();
  await page.getByRole("button", { name: "Save as new Prompt", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open saved Prompt" })).toBeVisible();
  const snapshot = await (await page.request.get("/api/demo/snapshot")).json();
  expect(
    snapshot.prompts.find((p: { title: string }) => p.title === "Metadata manual regression")
      .descriptor,
  ).toEqual({ purposes: [], tags: [] });
});

test("saved metadata changes survive navigation, reload and the independent publication preview", async ({
  page,
}) => {
  await page.goto("/zh-CN/app/generate");
  await page.locator("#goal").fill("分析销售数据后制定计划");
  await page.getByText("用途与标签 · 可选", { exact: true }).click();
  await page.getByRole("button", { name: "清空用途和标签" }).click();
  await page.getByRole("checkbox", { name: "分析与研究", exact: true }).check();
  await page.getByLabel("添加标签", { exact: true }).fill("本轮分类回归");
  await page.getByLabel("添加标签", { exact: true }).press("Enter");
  await page.reload();
  await page.getByText("用途与标签 · 可选", { exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "分析与研究", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "规划与决策", exact: true })).not.toBeChecked();
  await page.getByText("模拟演示 · 不调用模型", { exact: true }).click();
  await page.getByRole("button", { name: "生成模拟草稿", exact: true }).click();
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
  const snapshot = await (await page.request.get("/api/demo/snapshot")).json();
  const prompt = snapshot.prompts.find(
    (p: { title: string }) => p.title === "分析销售数据后制定计划",
  );
  await page.goto(`/zh-CN/app/prompts/${prompt.id}/edit`);
  await page.getByText("用途与标签 · 可选", { exact: true }).click();
  await page.getByRole("checkbox", { name: "规划与决策", exact: true }).check();
  await page.getByRole("button", { name: "保存为新版本", exact: true }).click();
  await expect(page.locator(".prompt-context-identity")).toContainText("v2");
  await page.reload();
  await page.getByText("用途与标签 · 可选", { exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "规划与决策", exact: true })).toBeChecked();
  const updated = await (await page.request.get("/api/demo/snapshot")).json();
  const saved = updated.prompts.find((p: { id: string }) => p.id === prompt.id);
  expect(saved.descriptor).toEqual({ purposes: ["analyze", "plan"], tags: ["本轮分类回归"] });
  const seed = await (
    await page.request.get(`/api/community/source?versionId=${saved.currentVersionId}`)
  ).json();
  expect(seed.descriptor).toEqual(saved.descriptor);
});
