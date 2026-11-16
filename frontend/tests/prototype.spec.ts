import { randomUUID } from "node:crypto";
import { expect, test } from "./fixtures";
import { createInitialState } from "../src/lib/fixtures";
import { cleanupTestAccount } from "../scripts/test-account.mjs";
import { cleanupE2eCalibrationReport, cleanupE2ePrompt } from "./db-cleanup";

const routePaths = [
  "/en",
  "/en/login",
  "/en/register",
  "/en/app",
  "/en/app/generate",
  "/en/app/prompts/prm_writing_course_01/edit",
  "/en/app/prompts/prm_writing_course_01/evaluate",
  "/en/app/prompts/prm_writing_course_01/optimize",
  "/en/app/library",
  "/en/app/library/lib_writing_study_plan_01",
  "/en/app/history",
  "/en/app/playground",
  "/en/app/execution-evaluation",
  "/en/pricing",
  "/en/app/account",
  "/en/app/settings",
  "/en/app/skills",
  "/en/help",
];

test("quota settings separate local estimates, reservations and plan safeguards", async ({
  page,
}) => {
  await page.route("**/api/ai/quota", (route) =>
    route.fulfill({
      json: {
        scope: "USER",
        tierCode: "FREE_V1",
        frozen: false,
        periodStart: "2026-11-05T00:00:00Z",
        periodEnd: "2026-12-05T00:00:00Z",
        periodTokenLimit: 300000,
        periodCostLimitUsd: 0.3,
        periodSettledTokens: 200,
        periodReservedTokens: 100,
        periodRemainingTokens: 299700,
        periodSettledCostUsd: 0.002,
        periodReservedCostUsd: 0.001,
        periodRemainingCostUsd: 0.297,
        platform: {
          dailyLimitUsd: 2,
          periodLimitUsd: 20,
          dailyUsedUsd: 0.003,
          periodUsedUsd: 0.003,
          periodEnd: "2026-12-05T00:00:00Z",
        },
        enabled: true,
        usageDay: "2026-11-05",
        resetTimezone: "UTC",
        dailyTokenLimit: 100000,
        reservedTokens: 100,
        settledTokens: 200,
        usedTokens: 300,
        remainingTokens: 99700,
        dailyCostLimitUsd: 0.12,
        reservedCostUsd: 0.001,
        settledCostUsd: 0.002,
        usedCostUsd: 0.003,
        remainingCostUsd: 0.117,
        currency: "USD",
        pricingWindow: "PEAK",
        pricingSourceUrl: "https://api-docs.deepseek.com/quick_start/pricing",
        pricingModel: "deepseek-flash",
        pricingProductVersion: "DeepSeek-V4.1-Flash-1017",
        pricingVerifiedAt: "2026-11-05T00:00:00Z",
        pricingValidUntil: "2026-12-05T00:00:00Z",
        costBasis: "LOCAL_ESTIMATE",
        pendingReconciliations: 2,
      },
    }),
  );
  await page.goto("/zh-CN/app/settings");
  const quota = page.getByRole("region", { name: "真实模型额度" });
  await expect(quota.getByText("今日剩余 tokens", { exact: true })).toBeVisible();
  await expect(quota.getByText(/已结算 \+ 预留 \/ 日上限/)).toBeHidden();
  await quota.getByText("用量明细与计费说明", { exact: true }).click();
  await expect(quota.getByText(/已结算 \+ 预留 \/ 日上限/)).toContainText("200 + 100 / 100,000");
  await expect(quota.getByText(/本地估算 USD/)).toContainText(
    "$0.00200000 + $0.00100000 / $0.12000000",
  );
  await expect(quota.getByText(/待供应商账单核对/)).toContainText("2");
  await expect(quota.getByText(/服务端套餐额度与试运营成本保护/)).toHaveCount(0);
  await expect(quota.getByText(/本地估算不等于供应商实扣费用/)).toBeVisible();
  await expect(quota.getByText(/30 天 tokens/)).toContainText("200 + 100 / 300,000");
  await expect(quota.getByText(/每日 UTC 00:00 重置/)).toBeVisible();
  await quota.getByRole("button", { name: "刷新用量" }).click();
  await expect(quota).toHaveAttribute("aria-busy", "false");
});

test("unavailable quota data never implies zero usage", async ({ page }) => {
  await page.route("**/api/ai/quota", (route) =>
    route.fulfill({ status: 503, json: { error: "MODEL_PRICING_UNAVAILABLE" } }),
  );
  await page.goto("/en/app/settings");
  const quota = page.getByRole("region", { name: "Live model quota" });
  await expect(quota.getByRole("status")).toContainText("no zero usage is inferred");
  await expect(quota.getByRole("status")).toContainText("MODEL_PRICING_UNAVAILABLE");
});

test("saved real execution evidence survives reload and preserves original Chinese text", async ({
  page,
}) => {
  // Synthetic HTTP fixture only: no real provider request and no database writes.
  await page.route("**/api/demo/snapshot", async (route) => {
    const response = await route.fetch();
    const snapshot = { ...(await response.json()), ...createInitialState() };
    snapshot.playgroundRuns = snapshot.versions.map((version: { id: string }) => ({
      id: `synthetic_${version.id}`,
      versionId: version.id,
      executionId: "mex_e2e_synthetic",
      source: "DEEPSEEK_LIVE_PLAYGROUND",
      outputs: [
        {
          name: "DeepSeek",
          text: "原始中文结果不会被模拟文案覆盖。",
          source: "DEEPSEEK_LIVE_PLAYGROUND",
        },
      ],
    }));
    await route.fulfill({ json: snapshot });
  });
  await page.goto("/zh-CN/app/playground");
  await expect(page.getByText("已执行 · 未评分", { exact: true })).toBeVisible();
  await expect(page.getByText("原始中文结果不会被模拟文案覆盖。", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("已执行 · 未评分", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "查看执行报告" }).click();
  await expect(page).toHaveURL(/\/zh-CN\/app\/execution-evaluation(?:\?.*)?$/);
  await page.locator(".execution-details > summary").click();
  await expect(page.getByText("已执行 · 未评分", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("原始中文结果不会被模拟文案覆盖。", { exact: true })).toBeVisible();
  const execution = page.getByRole("region", { name: "执行质量依据", exact: true });
  await expect(execution.getByText("score = null · grade = null", { exact: true })).toBeHidden();
  await execution.getByText("查看依据", { exact: true }).click();
  await expect(execution.getByText("score = null · grade = null", { exact: true })).toBeVisible();
});

test("all confirmed English routes render without browser errors", async ({ page }) => {
  const browserErrors: string[] = [];
  const failedResponses: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  });
  page.on("pageerror", (error) => browserErrors.push(`${page.url()}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("401 (Unauthorized)"))
      browserErrors.push(message.text());
  });
  for (const path of routePaths) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(200);
    await expect(page.locator("main").first(), path).toBeVisible();
  }
  expect(browserErrors, failedResponses.join("\n")).toEqual([]);
});

test("architecture preview stays explicit and bilingual across workflow pages", async ({
  page,
}) => {
  await page.goto("/zh-CN/app/generate");
  await page.getByRole("button", { name: "调整", exact: true }).click();
  await expect(page.getByRole("radio", { name: "自动选择", exact: true })).toBeChecked();
  await expect(page.getByText(/推荐可能适用的共享 Skills/)).toBeVisible();
  await expect(page.getByLabel("任务目标及明确约束")).toHaveCount(0);

  await page.goto("/zh-CN/app/prompts/prm_writing_course_01/evaluate");
  await page.locator(".advice-option > summary").click();
  await page.getByText("查看依据 · Skill 建议与正式评估分离", { exact: true }).click();
  await expect(page.getByText(/没有关联 Skill 建议/)).toBeVisible();

  await page.goto("/zh-CN/app/skills");
  await expect(page.getByRole("heading", { name: "Skills 库", exact: true })).toBeVisible();
  await page.getByText("查看依据 · 匹配规则", { exact: true }).click();
  await expect(page.getByText(/本地匹配推荐可能适合当前任务/)).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Skills 库" })
      .getByRole("button", { name: "添加 Skill", exact: true }),
  ).toBeVisible();

  await page.goto("/en/app/generate");
  await page.getByRole("button", { name: "Adjust", exact: true }).click();
  await expect(page.getByText(/Recommends potentially useful published Skills/)).toBeVisible();
});

test("Generator makes direct DeepSeek the primary action and keeps simulation explicit", async ({
  page,
}) => {
  await page.goto("/en/app/generate");
  await expect(page.getByRole("button", { name: "Generate with DeepSeek · Live" })).toHaveClass(
    /btn-primary/,
  );
  await page.getByText("Simulation · no model call", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Generate simulated draft" })).toBeVisible();
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("deepseek-direct");
  await expect(page.getByLabel("Model", { exact: true }).locator("option:checked")).toHaveText(
    "Direct · DeepSeek-V4.1-Flash-1017",
  );
  await expect(
    page.getByText("Uses model credits · saves automatically", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(/not a DeepSeek result/)).toBeVisible();
});

test("Stage 13A-2 exposes distinct live Optimize, Playground, and evaluation advice actions", async ({
  page,
}) => {
  await page.goto("/en/app/prompts/prm_writing_course_01/optimize");
  await expect(page.getByRole("button", { name: "Optimize with DeepSeek · Live" })).toBeVisible();
  await page.locator(".simulation-option > summary").click();
  await expect(page.getByRole("button", { name: "Apply and save as new version" })).toBeVisible();

  await page.goto("/en/app/playground");
  await expect(page.getByRole("button", { name: "Run DeepSeek · Live" })).toBeVisible();
  await page.locator(".simulation-option > summary").click();
  await expect(page.getByRole("button", { name: "Run simulated comparison" })).toBeVisible();
  await page
    .locator(".evidence-disclosure")
    .filter({ hasText: "score = null" })
    .locator("summary")
    .click();
  await expect(page.getByText("score = null · grade = null")).toBeVisible();

  await page.goto("/en/app/prompts/prm_writing_course_01/evaluate");
  await page.locator(".advice-option > summary").click();
  await expect(page.getByRole("button", { name: "Get DeepSeek advice · Live" })).toBeVisible();
  await page.locator(".calibration-option > summary").click();
  await expect(page.getByRole("button", { name: "Run mock evaluation" })).toBeVisible();
});

test("Generate → edit → evaluate → optimize uses a new version", async ({ page }) => {
  await page.goto("/en/app/generate");
  const testTitle = `E2E test: ${randomUUID()}`;
  await page.getByLabel("What do you want the AI to do?").fill(testTitle);
  await page.getByText("Simulation · no model call", { exact: true }).click();
  await page.getByRole("button", { name: "Generate simulated draft" }).click();
  const editorLink = page.getByRole("link", { name: "Continue editing" });
  const editorHref = await editorLink.getAttribute("href");
  const promptId = editorHref?.match(/\/prompts\/([^/]+)\/edit/)?.[1];
  expect(promptId).toBeTruthy();
  try {
    await editorLink.click();
    const prompt = page.getByLabel("Prompt content");
    await prompt.fill("A revised demo prompt with an explicit output format.");
    await page.getByRole("button", { name: "Save new version" }).click();
    await expect(page).toHaveURL(new RegExp(`/prompts/${promptId}/edit$`));
    await expect(page.locator(".prompt-context-identity")).toContainText("v2");
    await page.getByRole("link", { name: "Evaluate" }).click();
    await page.locator(".calibration-option > summary").click();
    await page.getByRole("button", { name: "Run mock evaluation" }).click();
    await expect(page.getByText("Mock / Simulated evaluation")).toBeVisible();
    await expect(page.getByText("NOT_EXECUTED").first()).toBeVisible();
    await page
      .getByRole("navigation", { name: "Current Prompt actions" })
      .getByRole("link", { name: "Optimize", exact: true })
      .click();
    await page.locator(".simulation-option > summary").click();
    await page.getByLabel(/Add a worked example/).check();
    await page.getByRole("button", { name: "Apply and save as new version" }).click();
    await expect(page.getByText(/New Prompt version saved/)).toBeVisible();
  } finally {
    if (promptId) await cleanupE2ePrompt(promptId, testTitle);
  }
});

test("General fallback and execution report never display a zero score", async ({ page }) => {
  await page.goto("/en/app/prompts/prm_general_notes_01/evaluate");
  await page.locator(".calibration-option > summary").click();
  const layer2Card = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Task-Specific Quality", exact: true }),
  });
  await expect(layer2Card.getByText("NOT_AVAILABLE", { exact: true })).toBeVisible();
  await expect(layer2Card.locator(".stat-value")).toHaveText("—");
  await expect(
    page.getByText("General is the fallback category; no Layer 2 score runs."),
  ).toBeVisible();
  await page.goto("/en/app/execution-evaluation");
  await page.locator(".execution-details > summary").click();
  await expect(page.getByText("NOT_EXECUTED", { exact: true }).first()).toBeVisible();
  const execution = page.getByRole("region", { name: "Execution quality evidence", exact: true });
  await expect(execution.getByText("score = null · grade = null")).toBeHidden();
  await execution.getByText("View evidence", { exact: true }).click();
  await expect(execution.getByText("score = null · grade = null")).toBeVisible();
});

test("Library catalog ID resolves to its shared Prompt record", async ({ page }) => {
  await page.goto("/en/app/library/lib_writing_study_plan_01");
  await expect(page.getByRole("heading", { name: "Three-day learning plan" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Evaluate this version" })).toHaveAttribute(
    "href",
    "/en/app/prompts/prm_writing_course_01/evaluate",
  );
});

test("registration rejects mismatched confirmation and accepts a match", async ({
  page,
  context,
}) => {
  await context.clearCookies();
  const email = `e2e-${randomUUID()}@example.test`;
  let calls = 0;
  await page.route("**/api/auth/register", (route) => {
    calls++;
    return route.continue();
  });
  try {
    await page.goto("/en/register");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill("example-password");
    await page.getByLabel("Confirm password").fill("different-password");
    await expect(page.locator("#password-mismatch")).toHaveText("Passwords do not match.");
    await expect(page.getByRole("button", { name: "Create account", exact: true })).toBeDisabled();
    expect(calls).toBe(0);
    await page.getByLabel("Confirm password").fill("example-password");
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await expect(page).toHaveURL(/\/en\/app$/);
    expect(calls).toBe(1);
    const snapshot = await (await context.request.get("/api/demo/snapshot")).json();
    expect(snapshot.prompts).toEqual([]);
    expect(snapshot.versions).toEqual([]);
  } finally {
    await cleanupTestAccount({ email });
  }
});

test("evaluation shows source text and dimension rationale for the bound version", async ({
  page,
}) => {
  await page.goto("/en/app/prompts/prm_writing_course_01/evaluate");
  await page.locator(".calibration-option > summary").click();
  await expect(page.getByText("Source excerpt")).toBeVisible();
  await expect(
    page.getByText("Exact text from ver_writing_course_03; the report is bound to this version."),
  ).toBeVisible();
  await expect(page.getByText("The prompt states a clear user goal.")).toBeVisible();
});

test("local human calibration saves an evidence-bound candidate report and restores it", async ({
  page,
  request,
}) => {
  const title = `E2E test: ${randomUUID()}`;
  const created = await request.post("/api/prompts", {
    headers: { origin: "http://127.0.0.1:3000" },
    data: {
      title,
      taskType: "General",
      content: "Synthetic calibration source text for a local test only.",
    },
  });
  expect(created.status()).toBe(201);
  const { promptId } = await created.json();
  try {
    await page.goto(`/en/app/prompts/${promptId}/evaluate`);
    await page.locator(".calibration-option > summary").click();
    await page.getByText("Review exact source text").click();
    const sourceText = await page.locator("pre").innerText();
    const excerpt = sourceText.slice(0, 24);
    const evidenceReason = `Synthetic UI test calibration ${randomUUID()}; source excerpt was checked against this exact version.`;
    await page.getByText("Local candidate calibration").click();
    await page.getByText("Layer 1 evidence assessment (24 indicators)").click();
    const dimensionSummaries = page.locator("form details > summary");
    for (let index = 0; index < (await dimensionSummaries.count()); index += 1) {
      await dimensionSummaries.nth(index).click();
    }
    const stateControls = page.locator('select[id$="-state"]');
    await expect(stateControls).toHaveCount(24);
    for (let index = 0; index < (await stateControls.count()); index += 1) {
      const state = stateControls.nth(index);
      const id = (await state.getAttribute("id"))!.replace("-state", "");
      await state.selectOption("SCORED");
      await page.locator(`#${id}-anchor`).selectOption("Q4");
      await page.locator(`#${id}-excerpt`).fill(excerpt);
      await page.locator(`#${id}-reason`).fill(evidenceReason);
    }
    const databaseSyncEnabled =
      process.env.PROMPTMASTER_DEMO_API_ENABLED === "true" &&
      process.env.NEXT_PUBLIC_PROMPTMASTER_DEMO_API_ENABLED === "true" &&
      Boolean(process.env.DATABASE_URL);
    if (!databaseSyncEnabled) {
      await page.getByRole("button", { name: "Save candidate calibration report" }).click();
      await expect(
        page.getByText("Candidate report saved for this browser session.", { exact: false }),
      ).toBeVisible();
      await expect(page.getByText("Local human calibration · candidate")).toBeVisible();
      await page.reload();
      await page.locator(".calibration-option > summary").click();
      await expect(page.getByText("Local human calibration · candidate")).toBeVisible();
      await expect(page.getByText("Calibration evidence snapshot")).toBeVisible();
      return;
    }
    let reportId: string | undefined;
    try {
      const reportResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          /\/api\/prompts\/[^/]+\/evaluations$/.test(response.url()),
      );
      await page.getByRole("button", { name: "Save candidate calibration report" }).click();
      const response = await reportResponse;
      expect(response.status()).toBe(201);
      reportId = (await response.json()).id as string;

      await expect(
        page.getByText("Candidate report saved to the local demo database.", { exact: false }),
      ).toBeVisible();
      await expect(page.getByText("Local human calibration · candidate")).toBeVisible();
      await expect(page.getByText("NOT_AVAILABLE", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("NOT_EXECUTED", { exact: true }).first()).toBeVisible();
      await expect(page.locator(".stat-value").first()).toHaveText("85.00");

      await page.reload();
      await page.locator(".calibration-option > summary").click();
      await expect(page.getByText("Local human calibration · candidate")).toBeVisible();
      await expect(page.getByText("Calibration evidence snapshot")).toBeVisible();
    } finally {
      if (reportId) await cleanupE2eCalibrationReport(reportId, evidenceReason);
    }
  } finally {
    await cleanupE2ePrompt(promptId, title);
  }
});

test("Chinese locale loads without horizontal document overflow at mobile width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/zh-CN/app/generate");
  await expect(page.getByRole("heading", { name: "Prompt 生成器" })).toBeVisible();
  const sizes = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(sizes.body).toBeLessThanOrEqual(sizes.viewport);
});

test("Chinese mode translates every route, task options, mode controls, and key business data", async ({
  page,
}) => {
  const chineseRoutes = routePaths.map((path) => path.replace("/en", "/zh-CN"));
  for (const path of chineseRoutes) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(200);
    await expect(page.locator("main").first(), path).toBeVisible();
  }

  await page.goto("/zh-CN/app/generate");
  await expect(page.locator("#classification")).toHaveCount(0);
  await page.getByText("用途与标签 · 可选", { exact: true }).click();
  const taskOptions = await page.locator(".descriptor-purposes label").allTextContents();
  expect(taskOptions).toEqual([
    "创作与表达",
    "理解与转换",
    "分析与研究",
    "规划与决策",
    "开发与构建",
    "检查与改进",
  ]);

  const modeToggle = page.getByRole("button", { name: /^专家模式 · 当前：/ });
  await expect(modeToggle).toHaveAttribute("aria-pressed", "false");
  await modeToggle.click();
  await expect(modeToggle).toHaveAttribute("aria-pressed", "true");
  await page.goto("/zh-CN/app/prompts/prm_writing_course_01/edit");

  await page.goto("/zh-CN/app/settings");
  await expect(
    page.locator("main").getByRole("button", { name: "简易模式", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator("main").getByRole("button", { name: "专家模式", exact: true }),
  ).toBeVisible();
  await page.goto("/zh-CN/pricing");
  await expect(
    page.getByText("Free 免费使用；Pro 为面向所有账号的 30 天测试套餐，均不自动续费。"),
  ).toBeVisible();
  await expect(page.getByText(/每 UTC 日 \/ 30 天 tokens/).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "立即订阅", exact: true })).toBeVisible();
  await page.goto("/zh-CN/register");
  await expect(page).toHaveURL(/\/zh-CN\/app$/);

  await page.goto("/zh-CN/app/prompts/prm_writing_course_01/edit");
  await page.getByRole("button", { name: /^专家模式 · 当前：/ }).click();
  await expect(page.getByLabel("角色")).toHaveValue("学习辅导");
  await expect(page.getByLabel("输出格式")).toHaveValue("分节结构");
});
