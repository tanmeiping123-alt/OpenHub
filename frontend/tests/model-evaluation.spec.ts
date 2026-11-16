import { test, expect } from "./fixtures";
import { createInitialState } from "../src/lib/fixtures";
import { MODEL_CATALOG } from "../src/lib/model-catalog";
import {
  LEGACY_MODEL_EVALUATION_VERSION,
  legacyModelEvaluationPrinciples,
  parseModelEvaluation,
} from "../src/lib/model-evaluation";
import { syntheticEvaluation } from "../src/lib/model-evaluation-fixture";
import { toLiveAdvice, type LiveSourceResponse } from "../src/lib/api-client";

const path = "/en/app/prompts/prm_writing_course_01/evaluate";
test.beforeEach(async ({ page }) => {
  await page.route("**/api/ai/**", (route) => route.abort());
  await page.route("**/api/skills/workflow", (route) => route.abort());
  await page.route("**/api/models", (route) =>
    route.fulfill({
      json: {
        models: MODEL_CATALOG.map((m) => ({ key: m.key, configured: true, maxOutputTokens: 1200 })),
      },
    }),
  );
});
function fixture() {
  const snapshot = createInitialState();
  const prompt = snapshot.prompts.find((p) => p.id === "prm_writing_course_01")!;
  const version = snapshot.versions.find((v) => v.id === prompt.currentVersionId)!;
  const result: LiveSourceResponse = {
    executionMode: "LIVE",
    purpose: "EVALUATION_REPORT",
    executionId: "mex_report_browser",
    promptId: prompt.id,
    versionId: version.id,
    provider: "deepseek",
    strength: "off",
    requestedModel: "deepseek-flash",
    resolvedModel: "deepseek-flash",
    productVersion: "DeepSeek-V4.1-Flash-1017",
    content: JSON.stringify(syntheticEvaluation(version.content)),
    evaluation: parseModelEvaluation(
      JSON.stringify(syntheticEvaluation(version.content)),
      version.content,
      prompt.taskType,
      "en",
    ),
    usage: { promptTokens: 210, completionTokens: 350, totalTokens: 560 },
    latencyMs: 2,
    createdAt: "2026-11-06T12:00:00Z",
  };
  return { snapshot, prompt, version, result };
}

test("selected review advice reaches optimization with exact report identity and no automatic call", async ({
  page,
}) => {
  const { snapshot, result } = fixture();
  snapshot.liveAdvice = [toLiveAdvice(result)];
  const requests: Record<string, unknown>[] = [];
  await page.route("**/api/demo/snapshot", (route) => route.fulfill({ json: snapshot }));
  await page.route("**/api/skills/workflow", (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    return route.fulfill({
      json:
        body.action === "plan"
          ? {
              id: "swp_review",
              analysis: {
                delivery: "SINGLE_PROMPT",
                stages: [],
                matching: { gaps: [], candidates: [] },
              },
              selections: [],
            }
          : {
              status: "SUCCEEDED",
              result: {
                promptId: result.promptId,
                versionId: result.versionId,
                optimizationId: "opt_review",
                executionId: "mex_optimized",
                content: "Review proposal",
                usage: { totalTokens: 20 },
              },
            },
    });
  });
  await page.goto(path);
  const panel = page.getByRole("region", { name: "Live evaluation report", exact: true });
  await panel.getByRole("checkbox", { name: "Use this suggestion in optimization" }).check();
  await panel.getByRole("link", { name: "Optimize 1 selected suggestions" }).click();
  await expect(page.locator(".evaluation-handoff")).toContainText(
    "Synthetic verification suggestion",
  );
  expect(requests).toHaveLength(0);
  await page.getByRole("button", { name: /Optimize.*Live|Optimize.*live|live.*optimi/i }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[0]).toMatchObject({
    action: "plan",
    source: { promptId: result.promptId, versionId: result.versionId },
    evaluationHandoff: { reportId: result.executionId, indexes: [0] },
  });
  expect(requests[0]).not.toHaveProperty("goal");
  expect(JSON.stringify(requests[0])).not.toContain("State explicit acceptance");
});

test("legacy report keeps its historical principles label in evidence and copied Markdown", async ({
  page,
  context,
}) => {
  const { snapshot, prompt, result } = fixture();
  const evaluation = result.evaluation!;
  evaluation.principlesVersion = LEGACY_MODEL_EVALUATION_VERSION;
  evaluation.principlesSnapshot = legacyModelEvaluationPrinciples(prompt.taskType, "en");
  snapshot.liveAdvice = [toLiveAdvice(result)];
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.route("**/api/demo/snapshot", (route) => route.fulfill({ json: snapshot }));
  await page.goto(path);
  const panel = page.getByRole("region", { name: "Live evaluation report", exact: true });
  await panel.getByText("View evidence", { exact: true }).click();
  await expect(
    panel.getByText(
      `${LEGACY_MODEL_EVALUATION_VERSION} · ${result.versionId} · ${result.executionId}`,
      { exact: true },
    ),
  ).toBeVisible();
  await panel.locator(".result-export > summary").click();
  await panel.getByRole("button", { name: "Copy Markdown" }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied.trim().endsWith(LEGACY_MODEL_EVALUATION_VERSION)).toBe(true);
  expect(copied).not.toContain("core-first-v2");
});

test("direct report displays principles, evidence, edits, usage and survives reload without changing formal reports", async ({
  page,
}) => {
  const { snapshot, result } = fixture();
  const formal = JSON.stringify(snapshot.reports);
  const calls: Record<string, unknown>[] = [];
  await page.route("**/api/demo/snapshot", (route) => route.fulfill({ json: snapshot }));
  await page.route("**/api/ai/evaluation-report", async (route) => {
    calls.push(route.request().postDataJSON());
    snapshot.liveAdvice = [toLiveAdvice(result)];
    await route.fulfill({ status: 201, json: result });
  });
  await page.goto(path);
  const panel = page.getByRole("region", { name: "Live evaluation report", exact: true });
  await expect(panel.getByText("DeepSeek-V4.1-Flash-1017 · Direct DeepSeek")).toBeVisible();
  expect(calls).toHaveLength(0);
  await page.goto(
    `/en/app/execution-evaluation?promptId=${result.promptId}&versionId=${result.versionId}`,
  );
  await panel.getByRole("button", { name: "Evaluate with DeepSeek · Live" }).click();
  await expect(
    panel.getByText("Saved · bound to this version · verify model conclusions"),
  ).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Layer 1 · General quality" })).not.toBeVisible();
  await panel.getByText("Read the full analysis and evidence", { exact: true }).click();
  await expect(panel.getByRole("heading", { name: "Layer 1 · General quality" })).toBeVisible();
  await expect(
    panel.getByRole("heading", { name: "Prioritized optimization suggestions" }),
  ).toBeVisible();
  await panel.locator(".result-export > summary").click();
  await expect(panel.getByRole("button", { name: "Copy Markdown" })).toBeVisible();
  await panel.getByText("View evidence", { exact: true }).click();
  await expect(panel.getByText(/210 input \+ 350 output = 560 tokens/)).toBeVisible();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    promptId: result.promptId,
    versionId: result.versionId,
    locale: "en",
  });
  expect(Object.keys(calls[0]).sort()).toEqual(["locale", "promptId", "requestKey", "versionId"]);
  expect(JSON.stringify(snapshot.reports)).toBe(formal);
  await page.reload();
  await expect(
    panel.getByText("Synthetic report for workflow verification only.", { exact: true }),
  ).toBeVisible();
  expect(calls).toHaveLength(1);
  await expect(page.getByLabel("Advice history for this version")).toHaveCount(0);
});

test("lost response recovers the same request after reload, with no automatic redispatch", async ({
  page,
}) => {
  const { snapshot, result } = fixture();
  const keys: string[] = [];
  await page.route("**/api/demo/snapshot", (route) => route.fulfill({ json: snapshot }));
  await page.route("**/api/ai/evaluation-report", async (route) => {
    keys.push(route.request().postDataJSON().requestKey);
    if (keys.length === 1) {
      await route.abort();
      return;
    }
    snapshot.liveAdvice = [toLiveAdvice(result)];
    await route.fulfill({ status: 201, json: result });
  });
  await page.goto(path);
  const panel = page.getByRole("region", { name: "Live evaluation report", exact: true });
  await panel.getByRole("button", { name: "Evaluate with DeepSeek · Live" }).click();
  await expect(panel.getByRole("alert")).toBeVisible();
  await page.reload();
  await expect(panel.getByRole("button", { name: "Recover evaluation request" })).toBeEnabled();
  expect(keys).toHaveLength(1);
  await panel.getByRole("button", { name: "Recover evaluation request" }).click();
  await expect(
    panel.getByText("Synthetic report for workflow verification only.", { exact: true }),
  ).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
});

test("direct reasoning and maximum output stay frozen while recovering a lost report", async ({
  page,
}) => {
  const { snapshot, result } = fixture();
  result.strength = "low";
  result.usage.reasoningTokens = 200;
  const calls: Record<string, unknown>[] = [];
  await page.route("**/api/models", (route) =>
    route.fulfill({
      json: {
        models: [
          {
            key: "deepseek-direct",
            configured: true,
            maxOutputTokens: 393216,
            timeoutMs: 30000,
            thinkingTimeoutMs: 300000,
          },
        ],
      },
    }),
  );
  await page.route("**/api/demo/snapshot", (route) => route.fulfill({ json: snapshot }));
  await page.route("**/api/ai/evaluation-report", async (route) => {
    calls.push(route.request().postDataJSON());
    if (calls.length === 1) return route.abort();
    snapshot.liveAdvice = [toLiveAdvice(result)];
    await route.fulfill({ status: 201, json: result });
  });
  await page.goto(path);
  const panel = page.getByRole("region", { name: "Live evaluation report", exact: true });
  await panel.locator(".model-controls > details > summary").click();
  await expect(panel.getByLabel("Output token budget (includes reasoning)")).toContainText(
    "393216 tokens",
  );
  await expect(panel.getByLabel("Reasoning strength").locator("option")).toHaveCount(4);
  await panel.getByLabel("Reasoning strength").selectOption("low");

  await expect(panel.getByText(/Request limit: 300s/)).toBeVisible();
  expect(calls).toHaveLength(0);
  await panel.getByRole("button", { name: "Evaluate with DeepSeek · Live" }).click();
  await expect(panel.getByRole("alert")).toBeVisible();
  await page.reload();
  await panel.locator(".model-controls > details > summary").click();
  await expect(panel.getByLabel("Reasoning strength")).toHaveValue("low");
  await expect(panel.getByLabel("Output token budget (includes reasoning)")).toContainText(
    "393216 tokens",
  );
  await expect(panel.getByLabel("Reasoning strength")).toBeDisabled();
  expect(calls).toHaveLength(1);
  await panel.getByRole("button", { name: "Recover evaluation request" }).click();
  await expect(
    panel.getByText("Synthetic report for workflow verification only.", { exact: true }),
  ).toBeVisible();
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0]);
  expect(calls[0]).toMatchObject({ strength: "low" });
  await panel.getByText("View evidence", { exact: true }).click();
  await expect(panel.getByText(/includes reasoning 200/)).toBeVisible();
});

test("unsaved edits disable live report; explicit supplier failure never displays mock success", async ({
  page,
}) => {
  const { snapshot } = fixture();
  let calls = 0;
  await page.route("**/api/demo/snapshot", (route) => route.fulfill({ json: snapshot }));
  await page.route("**/api/ai/evaluation-report", (route) => {
    calls++;
    return route.fulfill({
      status: 502,
      json: {
        error: "MODEL_EVALUATION_INVALID_REPORT",
        message: "Invalid source excerpt; usage retained, no retry.",
      },
    });
  });
  await page.goto(path);
  const panel = page.getByRole("region", { name: "Live evaluation report", exact: true });
  await panel.getByRole("button", { name: "Evaluate with DeepSeek · Live" }).click();
  await expect(panel.getByRole("alert")).toContainText("MODEL_EVALUATION_INVALID_REPORT");
  await expect(
    panel.getByText("Saved · bound to this version · verify model conclusions"),
  ).toHaveCount(0);
  expect(calls).toBe(1);
  await page.goto("/en/app/prompts/prm_writing_course_01/edit");
  await page.getByLabel("Prompt content", { exact: true }).fill("Unsaved changed source text");
  await page.getByRole("link", { name: "Evaluate", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: /Recover evaluation request|Evaluate with DeepSeek/ }),
  ).toBeDisabled();
  expect(calls).toBe(1);
});

test("report history is version-specific and remains readable on small and landscape screens", async ({
  page,
}, testInfo) => {
  const { snapshot, result, version } = fixture();
  snapshot.liveAdvice = [
    toLiveAdvice(result),
    {
      ...toLiveAdvice(result),
      executionId: "mex_unrelated",
      id: "adv_unrelated",
      versionId: "other-version",
      evaluation: { ...result.evaluation!, summary: "Unrelated version must stay hidden" },
    },
  ];
  await page.route("**/api/demo/snapshot", (route) => route.fulfill({ json: snapshot }));
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const viewport of [
    { width: 375, height: 812 },
    { width: 812, height: 375 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(path);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "20px";
    });
    const panel = page.getByRole("region", { name: "Live evaluation report", exact: true });
    await expect(
      panel.getByText("Synthetic report for workflow verification only.", { exact: true }),
    ).toBeVisible();
    await expect(panel.getByText("Unrelated version must stay hidden")).toHaveCount(0);
    await expect(page.locator(`#live-report-history-${version.id} option`)).toHaveCount(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`model-report-${viewport.width}.png`),
      fullPage: true,
    });
  }
});

test("report navigation exposes direct evaluation and shares saved reports with the prompt evaluator", async ({
  page,
}) => {
  const { snapshot, result } = fixture();
  const originalReports = JSON.stringify(snapshot.reports);
  const originalVersions = JSON.stringify(snapshot.versions);
  const calls: Record<string, unknown>[] = [];
  await page.route("**/api/demo/snapshot", (route) => route.fulfill({ json: snapshot }));
  await page.route("**/api/ai/evaluation-report", async (route) => {
    calls.push(route.request().postDataJSON());
    snapshot.liveAdvice = [toLiveAdvice(result)];
    await route.fulfill({ status: 201, json: result });
  });
  await page.goto(path);
  await page.getByRole("link", { name: "Evaluation report", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/app\/execution-evaluation$/);
  const panel = page.getByRole("region", { name: "Live evaluation report", exact: true });
  await expect(panel).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Evaluation report");
  await expect(page.locator(".execution-details")).not.toHaveAttribute("open");
  await page.locator(".execution-details > summary").click();
  await expect(page.getByRole("link", { name: "Open Playground for execution" })).toHaveAttribute(
    "href",
    "/en/app/playground?promptId=prm_coding_csv_01&versionId=ver_coding_csv_01",
  );
  expect(calls).toHaveLength(0);
  await page.goto(
    `/en/app/execution-evaluation?promptId=${result.promptId}&versionId=${result.versionId}`,
  );
  await panel.getByRole("button", { name: "Evaluate with DeepSeek · Live" }).click();
  await expect(
    panel.getByRole("heading", { name: "Prioritized optimization suggestions" }),
  ).toBeVisible();
  await panel.locator(".result-export > summary").click();
  await expect(panel.getByRole("button", { name: "Copy Markdown" })).toBeVisible();
  await panel.getByText("View evidence", { exact: true }).click();
  await expect(panel.getByText(/210 input \+ 350 output = 560 tokens/)).toBeVisible();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    promptId: result.promptId,
    versionId: result.versionId,
    locale: "en",
  });
  expect(Object.keys(calls[0]).sort()).toEqual(["locale", "promptId", "requestKey", "versionId"]);
  const executionDetails = page.locator(".execution-details");
  if (!(await executionDetails.evaluate((el) => (el as HTMLDetailsElement).open)))
    await executionDetails.locator(":scope > summary").click();
  const execution = page.getByRole("region", { name: "Execution quality evidence", exact: true });
  await expect(execution.getByText("NOT_EXECUTED", { exact: true })).toBeVisible();
  await expect(execution.getByText("score = null · grade = null")).toBeHidden();
  await execution.getByText("View evidence", { exact: true }).click();
  await expect(execution.getByText("score = null · grade = null")).toBeVisible();
  await page.reload();
  await expect(panel.getByText(result.evaluation!.summary, { exact: true })).toBeVisible();
  await page.goto(path);
  await expect(panel.getByText(result.evaluation!.summary, { exact: true })).toBeVisible();
  expect(calls).toHaveLength(1);
  expect(JSON.stringify(snapshot.reports)).toBe(originalReports);
  expect(JSON.stringify(snapshot.versions)).toBe(originalVersions);
  expect(snapshot.playgroundRuns).toHaveLength(0);
});

for (const content of ["Unsaved changed source text", ""]) {
  test(`report entry blocks unsaved ${content ? "changed" : "cleared"} drafts`, async ({
    page,
  }) => {
    const { snapshot } = fixture();
    let calls = 0;
    await page.route("**/api/demo/snapshot", (route) => route.fulfill({ json: snapshot }));
    await page.route("**/api/ai/evaluation-report", (route) => {
      calls++;
      return route.abort();
    });
    await page.goto("/en/app/prompts/prm_writing_course_01/edit");
    await page.getByLabel("Prompt content", { exact: true }).fill(content);
    await page.getByRole("link", { name: "Evaluation report", exact: true }).click();
    const panel = page.getByRole("region", { name: "Live evaluation report", exact: true });
    await expect(
      panel.getByRole("button", { name: "Evaluate with DeepSeek · Live" }),
    ).toBeDisabled();
    await expect(
      panel.getByText(
        "Save your edits before evaluating; this report belongs to the saved version only.",
      ),
    ).toBeVisible();
    await page.goto(path);
    await expect(
      panel.getByRole("button", { name: "Evaluate with DeepSeek · Live" }),
    ).toBeDisabled();
    expect(calls).toBe(0);
  });
}

test("report entry shows supplier failure without inventing a report or execution score", async ({
  page,
}) => {
  const { snapshot } = fixture();
  let calls = 0;
  await page.route("**/api/demo/snapshot", (route) => route.fulfill({ json: snapshot }));
  await page.route("**/api/ai/evaluation-report", (route) => {
    calls++;
    return route.fulfill({
      status: 502,
      json: { error: "MODEL_EVALUATION_INVALID_REPORT", message: "Synthetic invalid report" },
    });
  });
  await page.goto("/en/app/execution-evaluation");
  const panel = page.getByRole("region", { name: "Live evaluation report", exact: true });
  await panel.getByRole("button", { name: "Evaluate with DeepSeek · Live" }).click();
  await expect(panel.getByRole("alert")).toContainText("MODEL_EVALUATION_INVALID_REPORT");
  await expect(
    panel.getByText("Saved · bound to this version · verify model conclusions"),
  ).toHaveCount(0);
  await page.reload();
  await expect(panel.getByRole("button", { name: "Recover evaluation request" })).toBeEnabled();
  expect(calls).toBe(1);
  expect(snapshot.liveAdvice).toHaveLength(0);
  await expect(page.locator(".execution-details > summary")).toContainText("NOT_EXECUTED");
});

test("report entry binds the selected historical version and excludes reports from other versions", async ({
  page,
  testAccount,
}) => {
  const { snapshot, prompt, version, result } = fixture();
  const oldVersion = snapshot.versions.find(
    (v) => v.promptId === prompt.id && v.id !== version.id,
  )!;
  snapshot.draft = {
    promptId: prompt.id,
    parentVersionId: oldVersion.id,
    title: oldVersion.title,
    content: oldVersion.content,
    taskType: prompt.taskType,
  };
  const oldResult = {
    ...result,
    executionId: "mex_old_report",
    versionId: oldVersion.id,
    content: JSON.stringify(syntheticEvaluation(oldVersion.content)),
    evaluation: parseModelEvaluation(
      JSON.stringify(syntheticEvaluation(oldVersion.content)),
      oldVersion.content,
      prompt.taskType,
      "en",
    ),
  };
  snapshot.liveAdvice = [
    toLiveAdvice({
      ...result,
      evaluation: { ...result.evaluation!, summary: "Other version report must not appear" },
    }),
  ];
  await page.addInitScript(({ key, saved }) => sessionStorage.setItem(key, JSON.stringify(saved)), {
    key: `promptmaster-account-${testAccount.id}`,
    saved: snapshot,
  });
  const calls: Record<string, unknown>[] = [];
  await page.route("**/api/demo/snapshot", (route) => route.fulfill({ json: snapshot }));
  await page.route("**/api/ai/evaluation-report", async (route) => {
    calls.push(route.request().postDataJSON());
    snapshot.liveAdvice.push(toLiveAdvice(oldResult));
    await route.fulfill({ status: 201, json: oldResult });
  });
  await page.goto("/en/app/execution-evaluation");
  const panel = page.getByRole("region", { name: "Live evaluation report", exact: true });
  await expect(page.locator(".page-heading")).toContainText(`v${oldVersion.number}`);
  await expect(panel.getByText("Other version report must not appear")).toHaveCount(0);
  await panel.getByRole("button", { name: "Evaluate with DeepSeek · Live" }).click();
  await expect(panel.getByText(oldResult.evaluation.summary, { exact: true })).toBeVisible();
  expect(calls[0]).toMatchObject({ promptId: prompt.id, versionId: oldVersion.id });
  await expect(page.locator(`#live-report-history-${oldVersion.id} option`)).toHaveCount(1);
  await page.reload();
  await expect(panel.getByText(oldResult.evaluation.summary, { exact: true })).toBeVisible();
  expect(calls).toHaveLength(1);
});

test("real Playground evidence stays independent and ungraded alongside a saved Prompt report", async ({
  page,
}) => {
  const { snapshot, version, result } = fixture();
  snapshot.liveAdvice = [toLiveAdvice(result)];
  snapshot.playgroundRuns = [
    {
      id: "pg_synthetic_report",
      versionId: version.id,
      executionId: "mex_synthetic_playground",
      source: "DEEPSEEK_LIVE_PLAYGROUND",
      outputs: [
        {
          name: "DeepSeek",
          text: "Synthetic execution output, separate from Prompt review.",
          source: "DEEPSEEK_LIVE_PLAYGROUND",
        },
      ],
    },
  ];
  await page.route("**/api/demo/snapshot", (route) => route.fulfill({ json: snapshot }));
  await page.goto(
    `/en/app/execution-evaluation?promptId=${result.promptId}&versionId=${version.id}`,
  );
  await expect(
    page.getByRole("region", { name: "Live evaluation report", exact: true }),
  ).toBeVisible();
  const executionDetails = page.locator(".execution-details");
  if (!(await executionDetails.evaluate((el) => (el as HTMLDetailsElement).open)))
    await executionDetails.locator(":scope > summary").click();
  const execution = page.getByRole("region", { name: "Execution quality evidence", exact: true });
  await expect(execution.getByText("EXECUTED · UNGRADED", { exact: true })).toBeVisible();
  await expect(
    execution.getByText("Synthetic execution output, separate from Prompt review.", {
      exact: true,
    }),
  ).toBeVisible();
  await execution.getByText("View evidence", { exact: true }).click();
  await expect(execution.getByText("score = null · grade = null")).toBeVisible();
  await expect(execution.getByText("mex_synthetic_playground", { exact: true })).toBeVisible();
});

test("Chinese report entry explains separate execution status on small and landscape screens", async ({
  page,
  testAccount,
}, testInfo) => {
  const { snapshot, prompt, version, result } = fixture();
  snapshot.liveAdvice = [toLiveAdvice(result)];
  snapshot.draft = {
    promptId: prompt.id,
    parentVersionId: version.id,
    title: version.title,
    content: version.content,
    taskType: prompt.taskType,
  };
  await page.addInitScript(({ key, saved }) => sessionStorage.setItem(key, JSON.stringify(saved)), {
    key: `promptmaster-account-${testAccount.id}`,
    saved: snapshot,
  });
  await page.route("**/api/demo/snapshot", (route) => route.fulfill({ json: snapshot }));
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const viewport of [
    { width: 375, height: 812 },
    { width: 812, height: 375 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/zh-CN/app/execution-evaluation");
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "20px";
    });
    const panel = page.getByRole("region", { name: "真实模型评估报告", exact: true });
    await expect(panel.getByRole("button", { name: "DeepSeek 真实评估并生成报告" })).toBeEnabled();
    await expect(panel.getByRole("heading", { name: "优先优化建议" })).toBeVisible();
    await expect(page.locator(".execution-details > summary")).toContainText("执行记录");
    await page.locator(".execution-details > summary").click();
    await expect(page.getByText("此版本没有真实模型输出。执行分数和等级均为空。")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`report-entry-${viewport.width}.png`),
      fullPage: true,
    });
    await page.screenshot({ path: testInfo.outputPath(`report-entry-top-${viewport.width}.png`) });
    await page.getByRole("region", { name: "执行质量依据", exact: true }).screenshot({
      path: testInfo.outputPath(`report-entry-execution-${viewport.width}.png`),
    });
  }
});
