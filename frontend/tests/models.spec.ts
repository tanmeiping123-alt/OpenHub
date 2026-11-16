import { test, expect } from "./fixtures";
import { MODEL_CATALOG } from "../src/lib/model-catalog";
import { createInitialState, localizedContentFor } from "../src/lib/fixtures";
import type { Locator, Page } from "@playwright/test";

const emptyPlan = {
  id: "swp_sf_fixture",
  analysis: { delivery: "SINGLE_PROMPT", stages: [], matching: { gaps: [], candidates: [] } },
  selections: [],
};

async function openModelSettings(scope: Page | Locator) {
  const advanced = scope.locator(".model-controls > details");
  if ((await advanced.getAttribute("open")) === null) {
    await advanced.locator(":scope > summary").click();
  }
}

test.beforeEach(async ({ page }) => {
  // Never let a browser acceptance test reach a paid model endpoint.
  await page.route("**/api/ai/**", (r) => r.abort());
  await page.route("**/api/skills/workflow**", (r) => r.abort());
  await page.route("**/api/models", (r) =>
    r.fulfill({
      json: {
        models: MODEL_CATALOG.map((m) => ({
          key: m.key,
          configured: true,
          maxOutputTokens: 1200,
          timeoutMs: m.provider === "siliconflow" ? 300000 : 30000,
        })),
      },
    }),
  );
});

for (const scenario of [
  { page: "/zh-CN/app/generate", api: "generate", button: "使用 GLM-5.3 真实生成" },
  {
    page: "/zh-CN/app/prompts/prm_writing_course_01/optimize",
    api: "optimize",
    button: "使用 GLM-5.3 真实优化",
  },
  { page: "/zh-CN/app/playground", api: "playground", button: "运行 GLM-5.3 真实执行" },
  {
    page: "/zh-CN/app/prompts/prm_writing_course_01/evaluate",
    api: "evaluation-advice",
    button: "获取 GLM-5.3 真实建议",
  },
]) {
  test(`timeout feedback preserves uncertainty without automatic resend: ${scenario.api}`, async ({
    page,
  }) => {
    // Chinese preview fixtures must have a consistent saved/draft source, so a
    // translated English fixture does not trigger the unrelated dirty-draft guard.
    const snapshot = createInitialState();
    await page.route("**/api/demo/snapshot", (r) =>
      r.fulfill({
        json: {
          ...snapshot,
          versions: snapshot.versions.map((v) => ({
            ...v,
            content: localizedContentFor(v.id, "zh-CN", v.content),
          })),
        },
      }),
    );
    let calls = 0;
    const integrated = ["generate", "optimize"].includes(scenario.api);
    await page.route(integrated ? "**/api/skills/workflow" : `**/api/ai/${scenario.api}`, (r) => {
      if (integrated && r.request().postDataJSON().action === "plan")
        return r.fulfill({ json: emptyPlan });
      calls++;
      return r.fulfill({
        status: 504,
        json: { error: "MODEL_REQUEST_TIMEOUT", message: "Synthetic timeout; no paid request" },
      });
    });
    await page.goto(scenario.page);
    if (scenario.api === "evaluation-advice") {
      await page.locator(".advice-option > summary").click();
    }
    if (scenario.api === "generate")
      await page.getByLabel("你希望 AI 完成什么？").fill("任务软删除与恢复实施计划");
    await page.getByLabel("模型", { exact: true }).selectOption("zai-org/GLM-5.3");
    await expect(page.getByText(/等待上限: 300s/)).toBeVisible();
    await page.getByRole("button", { name: scenario.button, exact: true }).click();
    const alert = page.getByRole("main").getByRole("alert");
    await expect(alert).toContainText("系统不会自动重试");
    await expect(alert).toContainText("供应商可能仍在处理并产生费用");
    if (integrated) await alert.getByText("技术详情", { exact: true }).click();
    await expect(alert).toContainText("MODEL_REQUEST_TIMEOUT");
    expect(calls).toBe(1);
    if (integrated) {
      await expect(page.getByRole("button", { name: scenario.button, exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "核对本次请求", exact: true })).toBeEnabled();
    } else if (scenario.api === "playground") {
      await expect(page.getByRole("button", { name: scenario.button, exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "核对原请求", exact: true })).toBeEnabled();
    } else
      await expect(page.getByRole("button", { name: scenario.button, exact: true })).toBeEnabled();
    expect(calls).toBe(1);
  });
}

test("all four SiliconFlow choices send exact IDs and only supported tiers, with no automatic call", async ({
  page,
}) => {
  const calls: Record<string, unknown>[] = [];
  await page.route("**/api/skills/workflow", (r) => {
    if (r.request().postDataJSON().action === "plan") return r.fulfill({ json: emptyPlan });
    calls.push(r.request().postDataJSON());
    return r.fulfill({
      json: { status: "FAILED", error_code: "SYNTHETIC_UNAVAILABLE" },
    });
  });
  await page.goto("/zh-CN/app/generate");
  await page.getByLabel("你希望 AI 完成什么？").fill("任务软删除与恢复实施计划");
  await openModelSettings(page);
  for (const model of MODEL_CATALOG.filter((m) => m.provider === "siliconflow")) {
    await page.getByLabel("模型", { exact: true }).selectOption(model.key);
    const strength = page.getByLabel("推理强度");
    if (model.strengths.length > 1) {
      await expect(strength.locator("option")).toHaveCount(model.strengths.length);
      await expect(strength).toBeEnabled();
      await strength.selectOption("max");
    } else {
      await expect(strength).toHaveValue("default");
      await expect(strength).toBeDisabled();
    }
    await expect(
      page.getByLabel(
        model.key === "tencent/Hy4-preview"
          ? "输出 token 预算（含思考）"
          : "正文输出上限（不含思考 tokens）",
      ),
    ).toContainText("1200 tokens");
    const before = calls.length;
    await page.getByRole("button", { name: `使用 ${model.name} 真实生成`, exact: true }).click();
    const alert = page.getByRole("main").getByRole("alert");
    await alert.getByText("技术详情", { exact: true }).click();
    await expect(alert).toContainText("SYNTHETIC_UNAVAILABLE");
    expect(calls).toHaveLength(before + 1);
    expect(calls.at(-1)).toMatchObject({
      modelKey: model.key,
      strength: model.strengths.length > 1 ? "max" : "default",
    });
  }
  await page.getByText("模拟演示 · 不调用模型", { exact: true }).click();
  await expect(page.getByRole("button", { name: "生成模拟草稿", exact: true })).toBeVisible();
  expect(calls).toHaveLength(4);
});

test("Optimize, Playground and advice forward model settings without relabeling failures as success", async ({
  page,
}) => {
  const scenarios = [
    {
      page: "/en/app/prompts/prm_writing_course_01/optimize",
      api: "optimize",
      button: "Optimize with GLM-5.3 · Live",
    },
    { page: "/en/app/playground", api: "playground", button: "Run GLM-5.3 · Live" },
    {
      page: "/en/app/prompts/prm_writing_course_01/evaluate",
      api: "evaluation-advice",
      button: "Get GLM-5.3 advice · Live",
    },
  ];
  for (const scenario of scenarios) {
    const calls: unknown[] = [];
    const integrated = scenario.api === "optimize";
    await page.route(integrated ? "**/api/skills/workflow" : `**/api/ai/${scenario.api}`, (r) => {
      if (integrated && r.request().postDataJSON().action === "plan")
        return r.fulfill({ json: emptyPlan });
      calls.push(r.request().postDataJSON());
      return r.fulfill({
        status: 429,
        json: { error: "MODEL_USER_QUOTA_EXCEEDED", message: "Synthetic quota check" },
      });
    });
    await page.goto(scenario.page);
    if (scenario.api === "evaluation-advice") {
      await page.locator(".advice-option > summary").click();
    }
    await page.getByLabel("Model", { exact: true }).selectOption("zai-org/GLM-5.3");
    expect(calls).toHaveLength(0);
    await page.getByRole("button", { name: scenario.button, exact: true }).click();
    const alert = page.getByRole("main").getByRole("alert");
    if (integrated) await alert.getByText("Technical details", { exact: true }).click();
    await expect(alert).toContainText("MODEL_USER_QUOTA_EXCEEDED");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      modelKey: "zai-org/GLM-5.3",
      strength: "default",
      promptId: expect.any(String),
      versionId: expect.any(String),
    });
    expect(calls[0]).not.toHaveProperty("maxOutputTokens");
  }
});

test("a synthetic successful SiliconFlow generation preserves source and reasoning usage after reload", async ({
  page,
}) => {
  const snapshot = createInitialState();
  const evidence = {
    executionId: "mex_synthetic_sf",
    provider: "siliconflow" as const,
    requestedModel: "deepseek-ai/DeepSeek-V4-Pro",
    resolvedModel: "deepseek-ai/DeepSeek-V4-Pro",
    strength: "high" as const,
    usage: { promptTokens: 20, completionTokens: 30, totalTokens: 50, reasoningTokens: 25 },
  };
  let saved = false;
  await page.route("**/api/demo/snapshot", (r) =>
    r.fulfill({
      json: saved
        ? {
            ...snapshot,
            prompts: [
              {
                id: "prm_sf_synthetic",
                title: "Synthetic plan",
                taskType: "Coding",
                kind: "PERSONAL_PROMPT",
                currentVersionId: "ver_sf_synthetic",
                description: "Synthetic",
                favorite: false,
              },
              ...snapshot.prompts,
            ],
            versions: [
              {
                id: "ver_sf_synthetic",
                promptId: "prm_sf_synthetic",
                number: 1,
                title: "Synthetic plan",
                content: "SYNTHETIC SILICONFLOW RESULT",
                createdBy: "siliconflow-live",
                source: "SILICONFLOW_LIVE_GENERATION",
                createdAt: "2026-11-06",
                modelEvidence: evidence,
              },
              ...snapshot.versions,
            ],
          }
        : snapshot,
    }),
  );
  await page.route("**/api/skills/workflow", (r) => {
    if (r.request().postDataJSON().action === "plan") return r.fulfill({ json: emptyPlan });
    saved = true;
    return r.fulfill({
      status: 201,
      json: {
        status: "SUCCEEDED",
        result: {
          ...evidence,
          executionMode: "LIVE",
          promptId: "prm_sf_synthetic",
          versionId: "ver_sf_synthetic",
          title: "Synthetic plan",
          taskType: "Coding",
          content: "SYNTHETIC SILICONFLOW RESULT",
          productVersion: evidence.requestedModel,
          latencyMs: 1,
        },
      },
    });
  });
  await page.goto("/en/app/generate");
  await page.getByLabel("What do you want the AI to do?").fill("Synthetic plan");
  await page.getByLabel("Model", { exact: true }).selectOption(evidence.requestedModel);
  await openModelSettings(page);
  await page.getByLabel("Reasoning strength").selectOption("high");
  await page
    .getByRole("button", { name: "Generate with DeepSeek-V4-Pro · Live", exact: true })
    .click();
  await expect(
    page.getByRole("main").getByText("SYNTHETIC SILICONFLOW RESULT", { exact: true }),
  ).toBeVisible();
  await page.reload();
  const restore = page.getByRole("button", { name: "Restore saved task result", exact: true });
  if (await restore.isVisible()) await restore.click();
  await expect(
    page.getByRole("main").getByText("SYNTHETIC SILICONFLOW RESULT", { exact: true }),
  ).toBeVisible();
  const evidenceDetail = page
    .locator("details")
    .filter({ has: page.locator(".model-result-evidence") })
    .first();
  await evidenceDetail.locator("summary").first().click();
  await expect(evidenceDetail).toContainText("SILICONFLOW_LIVE_GENERATION");
  await expect(evidenceDetail).toContainText("20 input + 30 output = 50 tokens");
  await expect(evidenceDetail).toContainText("includes reasoning 25");
  await expect(evidenceDetail).toContainText("Think High");
});

test("Skills freezes one dispatch identity through reload, GET reconciliation and explicit continuation", async ({
  page,
}) => {
  const calls: { key?: string; body: Record<string, unknown> }[] = [];
  const checks: string[] = [];
  const snapshot = createInitialState();
  const result = {
    executionMode: "LIVE" as const,
    purpose: "PROMPT_GENERATION",
    executionId: "mex_reconciled",
    promptId: "prm_reconciled",
    versionId: "ver_reconciled",
    title: "Recovered generation",
    taskType: "General" as const,
    content: "SYNTHETIC GET RECONCILED GENERATION",
    provider: "siliconflow" as const,
    requestedModel: "deepseek-ai/DeepSeek-V4-Pro",
    resolvedModel: "deepseek-ai/DeepSeek-V4-Pro",
    productVersion: "DeepSeek-V4-Pro",
    strength: "max" as const,
    usage: { promptTokens: 20, completionTokens: 30, totalTokens: 50, reasoningTokens: 25 },
    latencyMs: 1,
  };
  await page.route("**/api/demo/snapshot", (r) => r.fulfill({ json: snapshot }));
  await page.route("**/api/skills/workflow**", (r) => {
    if (r.request().method() === "GET") {
      checks.push(new URL(r.request().url()).searchParams.get("requestKey")!);
      if (checks.length < 3)
        return r.fulfill({ json: { status: checks.length === 1 ? "RUNNING" : "NOT_FOUND" } });
      snapshot.prompts.unshift({
        id: result.promptId,
        title: result.title,
        taskType: "General",
        kind: "PERSONAL_PROMPT",
        currentVersionId: result.versionId,
        description: "Synthetic",
        favorite: false,
      });
      snapshot.versions.unshift({
        id: result.versionId,
        promptId: result.promptId,
        number: 1,
        title: result.title,
        content: result.content,
        createdBy: "siliconflow-live",
        source: "SILICONFLOW_LIVE_GENERATION",
        createdAt: "2026-11-10",
        modelEvidence: result,
      });
      return r.fulfill({ json: { status: "SUCCEEDED", result } });
    }
    const body = r.request().postDataJSON();
    if (body.action === "plan") return r.fulfill({ json: emptyPlan });
    calls.push({ key: r.request().headers()["idempotency-key"], body });
    return r.abort();
  });
  await page.goto("/en/app/generate");
  await page.getByLabel("What do you want the AI to do?").fill("Synthetic frozen goal");
  await page.getByLabel("Model", { exact: true }).selectOption("deepseek-ai/DeepSeek-V4-Pro");
  await openModelSettings(page);
  await page.getByLabel("Reasoning strength").selectOption("max");
  await expect(page.getByLabel("Answer token limit (excludes reasoning)")).toContainText(
    "1200 tokens",
  );
  await page
    .getByRole("button", { name: "Generate with DeepSeek-V4-Pro · Live", exact: true })
    .click();
  await expect(page.getByLabel("Model", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("What do you want the AI to do?")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Reconcile this request", exact: true }),
  ).toBeEnabled();
  expect(calls).toHaveLength(1);
  await page.reload();
  await expect(page.getByLabel("What do you want the AI to do?")).toHaveValue(
    "Synthetic frozen goal",
  );
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue(
    "deepseek-ai/DeepSeek-V4-Pro",
  );
  await openModelSettings(page);
  await expect(page.getByLabel("Reasoning strength")).toHaveValue("max");
  await expect(page.getByLabel("Answer token limit (excludes reasoning)")).toContainText(
    "1200 tokens",
  );
  await expect(page.getByLabel("Reasoning strength")).toBeDisabled();
  await page.getByRole("button", { name: "Reconcile this request", exact: true }).click();
  await expect.poll(() => checks.length).toBe(1);
  expect(calls).toHaveLength(1);
  await expect(
    page.getByRole("button", { name: "Continue with the same request", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Reconcile this request", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Continue with the same request", exact: true }),
  ).toBeEnabled();
  expect(calls).toHaveLength(1);
  await page.getByRole("button", { name: "Continue with the same request", exact: true }).click();
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[0]).toEqual(calls[1]);
  expect(checks).toEqual([calls[0].key, calls[0].key]);
  await expect(
    page.getByRole("button", { name: "Reconcile this request", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Reconcile this request", exact: true }).click();
  await expect(page.getByRole("main").getByText(result.content, { exact: true })).toBeVisible();
  expect(checks).toEqual([calls[0].key, calls[0].key, calls[0].key]);
  expect(calls).toHaveLength(2);
  await expect(page.getByLabel("Model", { exact: true })).toBeEnabled();
  expect(calls[0].body).toMatchObject({
    action: "run",
    modelKey: "deepseek-ai/DeepSeek-V4-Pro",
    strength: "max",
  });
});

test("model controls fit mobile and landscape at enlarged text with reduced motion", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const viewport of [
    { width: 375, height: 812 },
    { width: 812, height: 375 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/zh-CN/app/generate");
    await page.getByLabel("模型", { exact: true }).selectOption("deepseek-ai/DeepSeek-V4-Pro");
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "20px";
    });
    const controls = page.getByRole("group", { name: "真实模型设置" });
    await openModelSettings(page);
    await expect(controls).toBeVisible();
    if (viewport.width === 375)
      await expect(page.locator(".live-model-action")).toHaveCSS("flex-direction", "column");
    expect(await controls.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`models-${viewport.width}.png`),
      fullPage: true,
    });
  }
});
