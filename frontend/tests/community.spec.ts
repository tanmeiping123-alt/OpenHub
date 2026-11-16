import { test, expect } from "@playwright/test";

const card = {
  id: "op_ui_fixture",
  title: "把复杂问题讲清楚",
  summary: "把一个概念拆成直观解释、生活类比与可操作步骤。",
  taskType: "Writing",
  purposes: ["understand", "create"],
  language: "zh-CN",
  tags: ["学习", "解释"],
  author: { id: "creator_fixture", name: "林间", bio: "分享清晰、实用的提示词。" },
  stars: 12,
  recentStars: 3,
  versionNumber: 1,
  firstPublishedAt: "2026-11-06T00:00:00Z",
  updatedAt: "2026-11-06T00:00:00Z",
  status: "PUBLISHED",
};
const version = {
  number: 1,
  content: "请用生活中的类比解释 {{概念}}。\n<script>alert('unsafe')</script>",
  variables: "{{概念}}：你希望了解的概念",
  modelNotes: "作者建议使用文本模型",
  exampleInput: "什么是递归？",
  exampleOutput: "想象一面镜子面对另一面镜子。",
  usageNotes: "按自己的背景调整解释深度。",
  changeNote: "首次发布",
  hash: "a".repeat(64),
  license: "CC0-1.0",
  createdAt: "2026-11-06T00:00:00Z",
  origin: null,
};
test.beforeEach(async ({ page }) => {
  await page.route("**/api/community/viewer*", (r) =>
    r.fulfill({ json: { user: null, isOwner: false, starred: false } }),
  );
  await page.route("**/api/community?*", (r) =>
    r.fulfill({
      json: { items: [card], total: 1, page: 1, pageSize: 12, asOf: "2026-11-06T00:00:00Z" },
    }),
  );
  await page.route("**/api/community/op_ui_fixture*", (r) =>
    r.fulfill({
      json: {
        ...card,
        version,
        versions: [{ number: 1, changeNote: "首次发布", createdAt: version.createdAt }],
      },
    }),
  );
});
test("anonymous discovery, filtering and exact copying never load private data or run a model", async ({
  page,
  context,
}) => {
  const privateRequests: string[] = [];
  page.on("request", (r) => {
    if (/\/api\/(ai|demo|skills|prompts)\//.test(r.url())) privateRequests.push(r.url());
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/zh-CN/open-prompts");
  await expect(page.getByRole("heading", { name: "发现好用的 Prompt" })).toBeVisible();
  await page.getByLabel("搜索 Prompt").fill("解释");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page).toHaveURL(/q=/);
  await page.getByRole("link", { name: "把复杂问题讲清楚", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Prompt 正文" })).toContainText("<script>");
  await expect(page.locator(".op-prompt-body script")).toHaveCount(0);
  await page.getByRole("button", { name: "复制原文", exact: true }).click();
  expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe(
    version.content,
  );
  expect(privateRequests).toEqual([]);
});
test("community controls and long text fit a phone and landscape viewport", async ({
  page,
}, testInfo) => {
  for (const viewport of [
    { width: 375, height: 812 },
    { width: 812, height: 375 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/zh-CN/open-prompts");
    await expect(page.getByLabel("搜索 Prompt")).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`purpose-discovery-${viewport.width}.png`),
      fullPage: true,
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await page.getByRole("link", { name: "把复杂问题讲清楚", exact: true }).click();
    await expect(page.getByRole("button", { name: "复制原文", exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
  }
});
test("withdrawn content is replaced with a recovery state and no stale body", async ({ page }) => {
  await page.goto("/zh-CN/open-prompts/op_ui_fixture");
  await expect(page.getByRole("textbox", { name: "Prompt 正文" })).toBeVisible();
  await page.route("**/api/community/op_ui_fixture*", (r) =>
    r.fulfill({ status: 404, json: { error: "NOT_FOUND" } }),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("textbox", { name: "Prompt 正文" })).toHaveCount(0);
  await expect(
    page.getByText("这条 Prompt 不存在、已撤回或已下架。", { exact: true }),
  ).toBeVisible();
});
test("purpose, tag, ranking and language filters compose and survive navigation", async ({
  page,
}) => {
  await page.goto("/en/open-prompts?q=explain&language=en&page=2");
  await expect(page.getByRole("button", { name: "Most relevant" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Understand & transform" }).click();
  await expect(page).toHaveURL(/purpose=understand/);
  expect(new URL(page.url()).searchParams.has("page")).toBe(false);
  await page.getByRole("button", { name: "Past 7 days" }).click();
  await expect(page).toHaveURL(/sort=recent/);
  await page.getByLabel("Filter by tag").fill("learning");
  await page.getByRole("button", { name: "Apply tag" }).click();
  await expect(page).toHaveURL(/tag=learning/);
  const params = new URL(page.url()).searchParams;
  expect(Object.fromEntries(params)).toMatchObject({
    q: "explain",
    language: "en",
    purpose: "understand",
    sort: "recent",
    tag: "learning",
  });
  await page.goBack();
  await expect(page.getByLabel("Filter by tag")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Past 7 days" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
test("variable filling stays local, copies literal values and keeps original text available", async ({
  page,
  context,
}, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/en/open-prompts/op_ui_fixture");
  await page.getByText("Fill in variables", { exact: true }).click();
  await expect(page.getByRole("textbox", { name: "概念", exact: true })).toBeVisible();
  const initialStorage = await page.evaluate(() => ({
    session: { ...sessionStorage },
    local: { ...localStorage },
  }));
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") writes.push(request.url());
  });
  await page.getByRole("textbox", { name: "概念", exact: true }).fill("$& {{另一个变量}}");
  await expect(page.getByRole("textbox", { name: "Filled Prompt preview" })).toContainText(
    "$& {{另一个变量}}",
  );
  await page.screenshot({ path: testInfo.outputPath("local-variable-fill.png"), fullPage: true });
  await page.getByRole("button", { name: "Copy filled Prompt" }).click();
  expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe(
    version.content.replace("{{概念}}", () => "$& {{另一个变量}}"),
  );
  await page.getByRole("button", { name: "Copy original", exact: true }).click();
  expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe(
    version.content,
  );
  expect(writes).toEqual([]);
  expect(
    await page.evaluate(() => ({ session: { ...sessionStorage }, local: { ...localStorage } })),
  ).toEqual(initialStorage);
  expect(new URL(page.url()).search).toBe("");
  await page.reload();
  await page.getByText("Fill in variables", { exact: true }).click();
  await expect(page.getByRole("textbox", { name: "概念", exact: true })).toHaveValue("");
});
