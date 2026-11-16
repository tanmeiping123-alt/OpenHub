import { test, expect } from "./fixtures";
import { createInitialState } from "../src/lib/fixtures";
import { playgroundSystemInstruction } from "../src/lib/playground-policy";

test("uncategorized mixed request keeps independently edited metadata and exact body", async ({
  page,
}, testInfo) => {
  const calls: string[] = [];
  await page.route("**/api/ai/**", (r) => {
    calls.push(r.request().url());
    return r.abort();
  });
  await page.goto("/zh-CN/app/generate");
  await expect(page.locator("#classification")).toHaveCount(0);
  const goal = "分析这份销售数据，找出下滑原因，再写给老板的汇报。金额 500 元，2026-11-10 截止。";
  await page.locator("#goal").fill(goal);
  await page.getByText("用途与标签 · 可选", { exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "创作与表达", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "分析与研究", exact: true })).toBeChecked();
  await page.getByRole("button", { name: "清空用途和标签" }).click();
  await page.getByRole("checkbox", { name: "分析与研究", exact: true }).check();
  await page.getByLabel("添加标签", { exact: true }).fill("经营");
  await page.getByLabel("添加标签", { exact: true }).press("Enter");
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`core-first-metadata-${width}.png`),
      fullPage: true,
    });
  }
  await page.getByText("模拟演示 · 不调用模型", { exact: true }).click();
  await page.getByRole("button", { name: "生成模拟草稿", exact: true }).click();
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
  const snapshot = await (await page.request.get("/api/demo/snapshot")).json();
  const prompt = snapshot.prompts.find((p: { title: string }) => p.title === goal.slice(0, 56));
  expect(prompt.descriptor).toEqual({ purposes: ["analyze"], tags: ["经营"] });
  expect(prompt.taskType).toBe("General");
  expect(
    snapshot.versions.find((v: { id: string }) => v.id === prompt.currentVersionId).content,
  ).toBe(goal);
  expect(calls).toEqual([]);
});

test("unchanged live optimization shows no-change result and never offers a duplicate version write", async ({
  page,
}) => {
  const snapshot = createInitialState();
  const prompt = snapshot.prompts.find((p) => p.id === "prm_writing_course_01")!;
  const version = snapshot.versions.find((v) => v.id === prompt.currentVersionId)!;
  let writes = 0;
  await page.route("**/api/demo/snapshot", (r) => r.fulfill({ json: snapshot }));
  await page.route("**/api/models", (r) =>
    r.fulfill({
      json: { models: [{ key: "deepseek-direct", configured: true, maxOutputTokens: 1200 }] },
    }),
  );
  await page.route("**/api/skills/workflow", (r) => {
    if (r.request().postDataJSON().action === "plan")
      return r.fulfill({
        json: {
          id: "swp_nochange",
          analysis: { delivery: "SINGLE_PROMPT", stages: [] },
          selections: [],
        },
      });
    return r.fulfill({
      status: 201,
      json: {
        status: "SUCCEEDED",
        result: {
          executionMode: "LIVE",
          purpose: "OPTIMIZATION",
          executionId: "mex_nochange",
          promptId: prompt.id,
          versionId: version.id,
          content: version.content,
          provider: "deepseek",
          requestedModel: "deepseek-flash",
          resolvedModel: "deepseek-flash",
          productVersion: "DeepSeek-V4.1-Flash-1017",
          usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
          latencyMs: 1,
          optimizationId: "opt_nochange",
        },
      },
    });
  });
  await page.route("**/api/prompts/*/versions", (r) => {
    writes++;
    return r.abort();
  });
  await page.goto(`/en/app/prompts/${prompt.id}/optimize`);
  await page.getByRole("button", { name: "Optimize with DeepSeek · Live", exact: true }).click();
  await expect(page.getByText(/The current expression is already clear/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save live proposal as new version", exact: true }),
  ).toBeDisabled();
  await page.getByText("View evidence", { exact: true }).first().click();
  await expect(page.getByText(/30 tokens/).first()).toBeVisible();
  expect(writes).toBe(0);
});

test("history compares exact stored requirements using additions and deletions", async ({
  page,
}, testInfo) => {
  await page.route("**/api/demo/snapshot", (r) => r.fulfill({ json: createInitialState() }));
  await page.goto("/zh-CN/app/history");
  await page
    .locator(".list-row")
    .filter({ hasText: "三天学习计划 · v3" })
    .getByRole("button", { name: "比较", exact: true })
    .click();
  const diff = page.getByLabel("正文差异", { exact: true });
  await expect(diff).toBeVisible();
  await expect(diff.locator("ins")).not.toHaveCount(0);
  await expect(diff.locator("del")).not.toHaveCount(0);
  await expect(page.getByText("比较 v2 → v3", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("core-first-history.png"), fullPage: true });
});

test("playground discloses the same platform instruction used by dispatch without running a model", async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route("**/api/demo/snapshot", (r) => r.fulfill({ json: createInitialState() }));
  await page.route("**/api/ai/**", (r) => {
    requests.push(r.request().url());
    return r.abort();
  });
  for (const locale of ["en", "zh-CN"] as const) {
    await page.goto(`/${locale}/app/playground`);
    const panel = page.locator("section").filter({
      has: page.getByRole("heading", {
        name: locale === "en" ? "Prompt snapshot" : "Prompt 快照",
        exact: true,
      }),
    });
    await panel.getByText(locale === "en" ? "View evidence" : "查看依据", { exact: true }).click();
    await expect(
      panel.getByText(playgroundSystemInstruction(locale), { exact: false }),
    ).toBeVisible();
  }
  expect(requests).toEqual([]);
});
