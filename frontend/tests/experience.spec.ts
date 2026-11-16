import { expect, test } from "./fixtures";
import { createInitialState } from "../src/lib/fixtures";

test.beforeEach(async ({ page }) => {
  // A UI-only task must never incur live-provider charges, including on regressions.
  await page.route("**/api/ai/**", (r) =>
    r.fulfill({ status: 503, json: { error: "UI_TEST_NO_LIVE_CALL" } }),
  );
});

test("result body, Markdown, exports and continued editing preserve content without writes", async ({
  page,
  context,
}) => {
  const demo = createInitialState();
  const prompt = demo.prompts[0];
  const version = demo.versions.find((v) => v.id === prompt.currentVersionId)!;
  const content =
    "# 中文软删除计划\n\n- **保留任务**\n- 恢复任务\n```sql\nSELECT deleted_at FROM tasks;\n```";
  await page.route("**/api/demo/snapshot", (r) =>
    r.fulfill({
      json: {
        ...demo,
        versions: demo.versions.map((v) => (v.id === version.id ? { ...v, content } : v)),
      },
    }),
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET") writes.push(r.url());
  });
  await page.goto(`/zh-CN/app/prompts/${prompt.id}/edit`);
  const body = page.getByLabel("Prompt 内容", { exact: true });
  // Fixture localizations intentionally replace historic content; edit a draft to test exact source.
  await body.fill(content);
  await page.getByRole("button", { name: "复制正文", exact: true }).click();
  await expect(page.getByText("已复制正文。", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("• 保留任务");
  await page.locator(".result-export > summary").click();
  await page.getByRole("button", { name: "复制 Markdown", exact: true }).click();
  await expect(page.getByText("已复制 Markdown。", { exact: true })).toBeVisible();
  // Windows clipboard exposes CRLF even when writeText was given LF.
  expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe(
    content,
  );
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Markdown (.md)" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^PromptMaster-.*\.md$/);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString("utf8")).toBe(content);
  await page.goto("/zh-CN/app/generate");
  await expect(page.locator(".result-body").filter({ hasText: "中文软删除计划" })).toBeVisible();
  await page.getByRole("link", { name: "继续编辑", exact: true }).click();
  await expect(body).toHaveValue(content);
  expect(writes).toEqual([]);
});

test("Skills have a dedicated authenticated entrance; settings remain compact and old anchor works", async ({
  page,
}) => {
  await page.goto("/zh-CN/app/settings");
  await expect(page.getByRole("region", { name: "Skills 库", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "打开 Skills 管理", exact: true }).click();
  await expect(page).toHaveURL(/\/zh-CN\/app\/skills$/);
  await expect(page.getByRole("region", { name: "Skills 库", exact: true })).toBeVisible();
  await expect(
    page.getByRole("complementary").getByRole("link", { name: "Skills 管理", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.goto("/zh-CN/app/settings#skills-library");
  await expect(page).toHaveURL(/\/zh-CN\/app\/skills$/);
});

test("mocked live result shows save state first, hides token evidence, and keeps an unsaved proposal separate", async ({
  page,
}) => {
  const initial = createInitialState();
  const promptId = "prm_experience_live",
    versionId = "ver_experience_live";
  const content = "# 软删除与恢复\n\n先备份，再增加 deleted_at，并验证恢复后的可见性。";
  const prompt = {
    id: promptId,
    title: "中文实施规划",
    taskType: "Writing",
    kind: "PERSONAL_PROMPT",
    currentVersionId: versionId,
    description: "",
    favorite: false,
  };
  const version = {
    id: versionId,
    promptId,
    title: prompt.title,
    content,
    number: 1,
    source: "DEEPSEEK_LIVE_GENERATION",
    createdBy: "fixture",
    createdAt: "2026-11-06T00:00:00Z",
  };
  let generated = false;
  await page.route("**/api/demo/snapshot", (r) =>
    r.fulfill({
      json: {
        ...initial,
        prompts: generated ? [prompt] : [],
        versions: generated ? [version] : [],
        reports: [],
        history: [],
        favorites: [],
        playgroundRuns: [],
        liveAdvice: [],
        libraryPromptIds: [],
      },
    }),
  );
  const response = {
    executionMode: "LIVE",
    executionId: "mex_ui_only",
    promptId,
    versionId,
    title: prompt.title,
    taskType: "Writing",
    content,
    provider: "deepseek",
    requestedModel: "deepseek-flash",
    resolvedModel: "deepseek-flash",
    productVersion: "DeepSeek-V4.1-Flash-1017",
    usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
    latencyMs: 100,
  };
  await page.route("**/api/skills/workflow", (r) => {
    if (r.request().postDataJSON().action === "plan")
      return r.fulfill({
        json: {
          id: "swp_experience",
          analysis: { delivery: "SINGLE_PROMPT", stages: [] },
          selections: [],
        },
      });
    generated = true;
    return r.fulfill({ json: { status: "SUCCEEDED", result: response } });
  });
  await page.goto("/zh-CN/app/generate");
  await page.getByLabel("你希望 AI 完成什么？", { exact: true }).fill("任务软删除与恢复");
  await page.getByRole("button", { name: "使用 DeepSeek 真实生成", exact: true }).click();
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
  await expect(page.locator(".result-body")).toHaveText(content);
  const tokens = page.getByText(/output = 300 tokens/);
  await expect(tokens).toBeHidden();
  // Generation evidence uses version/model/token data, not a mutable source marker.
  await page
    .locator(".evidence-disclosure")
    .filter({ hasText: versionId })
    .locator("summary")
    .click();
  await expect(tokens).toBeVisible();
  await page.getByRole("link", { name: "继续编辑", exact: true }).click();
  await expect(page.getByLabel("Prompt 内容", { exact: true })).toHaveValue(content);

  const proposal = "# 优化后的规划\n\n增加幂等恢复及权限隔离测试。";
  await page.route("**/api/skills/workflow", (r) =>
    r.fulfill({
      json:
        r.request().postDataJSON().action === "plan"
          ? {
              id: "swp_opt_experience",
              analysis: { delivery: "SINGLE_PROMPT", stages: [] },
              selections: [],
            }
          : {
              status: "SUCCEEDED",
              result: { ...response, purpose: "OPTIMIZATION", content: proposal },
            },
    }),
  );
  await page.getByRole("link", { name: "优化", exact: true }).click();
  await page.getByRole("button", { name: "使用 DeepSeek 真实优化", exact: true }).click();
  const liveResult = page
    .locator(".panel")
    .filter({ has: page.getByRole("button", { name: "将真实优化结果另存为新版本", exact: true }) });
  await expect(liveResult.getByText(/来源版本未改变/)).toBeVisible();
  await expect(liveResult.getByRole("link", { name: "继续编辑", exact: true })).toHaveCount(0);
  await expect(liveResult.getByText(proposal, { exact: true })).toBeVisible();
  await page.locator(".prompt-context").getByRole("link", { name: "编辑", exact: true }).click();
  await expect(page.getByLabel("Prompt 内容", { exact: true })).toHaveValue(content);
});

test("failed editor save remains a draft and never announces saved", async ({ page }) => {
  await page.route("**/api/prompts/*/versions", (r) =>
    r.fulfill({ status: 503, json: { error: "UI_TEST_SAVE_FAILED" } }),
  );
  await page.goto("/zh-CN/app/prompts/prm_writing_course_01/edit");
  await page.getByLabel("Prompt 内容", { exact: true }).fill("保留这份草稿，不要声称保存成功。");
  await page.getByRole("button", { name: "保存为新版本", exact: true }).click();
  await expect(
    page.getByText("保存失败或尚未确认，草稿已保留，请查看提示。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Prompt 内容", { exact: true })).toHaveValue(
    "保留这份草稿，不要声称保存成功。",
  );
  await expect(page.getByText("已保存为新版本", { exact: true })).toHaveCount(0);
});

test("account recovery help stays public and never offers an unimplemented reset form", async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await page.goto("/zh-CN/login");
  await page.getByRole("link", { name: "忘记密码 / 账号恢复", exact: true }).click();
  await expect(page).toHaveURL(/\/zh-CN\/help#recovery$/);
  await expect(page.getByText(/账号恢复尚未实现/)).toBeVisible();
  await expect(page.locator("form")).toHaveCount(0);
  await expect(page.getByText(/注册新账号不会恢复原账号/)).toBeVisible();
  await page.goto("/en/help");
  await expect(page.getByText(/Account recovery is not implemented/)).toBeVisible();
  await page.goto("/en/app/skills");
  await expect(page).toHaveURL(/\/en\/login\?/);
});

test("persistent favorites filter combines with search and task filters and is keyboard accessible", async ({
  page,
}) => {
  const demo = createInitialState();
  const favorite = demo.prompts.find((p) => demo.libraryPromptIds.includes(p.id))!;
  await page.route("**/api/demo/snapshot", (r) =>
    r.fulfill({ json: { ...demo, favorites: [favorite.id] } }),
  );
  await page.goto("/en/app/library");
  const all = page.getByRole("radio", { name: "All prompts", exact: true });
  const favorites = page.getByRole("radio", { name: "Favorites", exact: true });
  await expect(all).toBeChecked();
  await all.focus();
  await page.keyboard.press("ArrowRight");
  await expect(favorites).toBeChecked();
  await expect(all).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "1 prompts · Favorites" })).toBeVisible();
  await page.getByRole("textbox", { name: "Search prompts" }).fill("NO_MATCH_FOR_ANY_PROMPT");
  await expect(page.getByText("No prompts found", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(all).toBeChecked();
  await expect(page.getByRole("textbox", { name: "Search prompts" })).toHaveValue("");
  await expect(page.getByRole("combobox", { name: "Filter by purpose" })).toHaveValue("All");
});

test("engineering details default to closed and pages reflow on phones, landscape and 200% text", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const viewport of [
    { width: 375, height: 812 },
    { width: 812, height: 375 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    for (const path of [
      "/zh-CN/app/generate",
      "/zh-CN/app/library",
      "/zh-CN/app/skills",
      "/zh-CN/help",
    ]) {
      await page.goto(path);
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "200%";
      });
      await expect(page.locator("h1")).toBeVisible();
      if (path.endsWith("library"))
        await expect(page.getByRole("textbox", { name: "搜索 Prompt", exact: true })).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
      if (viewport.width !== 812)
        await page.screenshot({
          path: testInfo.outputPath(`${viewport.width}-${path.split("/").pop()}.png`),
          fullPage: true,
        });
      if (path.endsWith("generate")) {
        const skills = page.getByRole("region", { name: "本次任务的 Skills" });
        await expect(skills.getByRole("button", { name: "调整", exact: true })).toHaveAttribute(
          "aria-expanded",
          "false",
        );
        await expect(page.getByText("PG-05 · P0", { exact: true })).toHaveCount(0);
        await skills.getByRole("button", { name: "调整", exact: true }).click();
        await expect(skills.getByRole("radio", { name: "自动选择", exact: true })).toBeVisible();
        await expect(page.getByLabel("任务目标及明确约束")).toHaveCount(0);
        await expect(page.getByText("PG-05 · P0", { exact: true })).toHaveCount(0);
      }
    }
  }
});
