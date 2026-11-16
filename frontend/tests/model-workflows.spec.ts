import { test, expect } from "./fixtures";
import { MODEL_CATALOG, liveSource } from "../src/lib/model-catalog";
import { createInitialState } from "../src/lib/fixtures";

test.beforeEach(async ({ page }) => {
  // Safety net: no unhandled AI or Skill execution may reach the local service.
  await page.route("**/api/ai/**", (route) => route.abort());
  await page.route("**/api/skills/workflow**", (route) => route.abort());
  await page.route("**/api/models", (route) =>
    route.fulfill({
      json: {
        models: MODEL_CATALOG.map((m) => ({
          key: m.key,
          configured: true,
          maxOutputTokens: 1200,
          timeoutMs: m.provider === "deepseek" ? 30000 : 300000,
        })),
      },
    }),
  );
});

for (const scenario of [
  {
    path: "/en/app/playground",
    api: "playground",
    purpose: "PLAYGROUND",
    label: "Run",
    suffix: "",
  },
  {
    path: "/en/app/prompts/prm_writing_course_01/evaluate",
    api: "evaluation-advice",
    purpose: "EVALUATION_ADVICE",
    label: "Get",
    suffix: " advice",
  },
] as const) {
  test(`five-model successful ${scenario.api} keeps source and usage through switching and reload (mocked supplier)`, async ({
    page,
  }) => {
    const snapshot = createInitialState();
    const calls: Record<string, unknown>[] = [];
    await page.route("**/api/demo/snapshot", (route) => route.fulfill({ json: snapshot }));
    await page.route(`**/api/ai/${scenario.api}`, async (route) => {
      const input = route.request().postDataJSON();
      const model = MODEL_CATALOG.find((m) => m.key === input.modelKey)!;
      calls.push(input);
      expect(
        snapshot.versions.some((v) => v.id === input.versionId && v.promptId === input.promptId),
      ).toBe(true);
      const usage = {
        promptTokens: 20,
        completionTokens: 30,
        totalTokens: 50,
        reasoningTokens: model.defaultStrength === "off" ? 0 : 25,
      };
      const result = {
        executionMode: "LIVE",
        purpose: scenario.purpose,
        executionId: `mex_browser_${calls.length}`,
        promptId: input.promptId,
        versionId: input.versionId,
        provider: model.provider,
        requestedModel: model.model,
        resolvedModel: model.model,
        productVersion: model.name,
        strength: input.strength,
        content: `SYNTHETIC ${scenario.api} ${model.key}`,
        usage,
        latencyMs: 1,
        optimizationId: `opt_browser_${calls.length}`,
        sessionId: `pls_browser_${calls.length}`,
      };
      if (scenario.api === "evaluation-advice")
        snapshot.liveAdvice.unshift({
          ...result,
          id: `adv_${result.executionId}`,
          model: model.model,
          createdAt: new Date().toISOString(),
        });
      if (scenario.api === "playground")
        snapshot.playgroundRuns.unshift({
          id: result.sessionId,
          versionId: result.versionId,
          source: liveSource(model.provider, "PLAYGROUND"),
          executionId: result.executionId,
          modelEvidence: result,
          outputs: [
            {
              name: `${model.provider} · ${model.model}`,
              text: result.content,
              source: liveSource(model.provider, "PLAYGROUND"),
            },
          ],
        });
      await route.fulfill({ status: 201, json: result });
    });
    await page.goto(scenario.path);
    if (scenario.api === "evaluation-advice")
      await page.locator(".advice-option > summary").click();
    const controls =
      scenario.api === "evaluation-advice"
        ? page.locator(".advice-option .model-controls")
        : page.locator(".model-controls");
    await controls.locator("details > summary").first().click();
    const modelSelect = page.getByLabel("Model", { exact: true });
    await expect(modelSelect).toHaveValue("deepseek-direct");
    for (const model of MODEL_CATALOG) {
      const before = calls.length;
      await modelSelect.selectOption(model.key);
      await expect(controls.getByLabel("Reasoning strength")).toHaveValue(model.defaultStrength);
      await expect(
        controls.getByLabel(
          model.provider === "deepseek" || model.key === "tencent/Hy4-preview"
            ? "Output token budget (includes reasoning)"
            : "Answer token limit (excludes reasoning)",
        ),
      ).toContainText("1200 tokens");
      expect(calls).toHaveLength(before);
      await page
        .getByRole("button", {
          name: `${scenario.label} ${model.provider === "deepseek" ? "DeepSeek" : model.name}${scenario.suffix} · Live`,
          exact: true,
        })
        .click();
      await expect(
        page.getByText(`SYNTHETIC ${scenario.api} ${model.key}`, { exact: true }),
      ).toBeVisible();
      expect(calls).toHaveLength(before + 1);
      expect(calls.at(-1)).toMatchObject({
        modelKey: model.key,
        strength: model.defaultStrength,
        locale: "en",
      });
    }
    if (scenario.api === "evaluation-advice") {
      await expect(
        page.getByLabel("Advice history for this version").locator("option"),
      ).toHaveCount(6);
      await modelSelect.selectOption("deepseek-direct");
      await expect(
        page.getByText("SYNTHETIC evaluation-advice deepseek-direct", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("SYNTHETIC evaluation-advice deepseek-ai/DeepSeek-V4-Pro", { exact: true }),
      ).not.toBeVisible();
      await page.getByLabel("Advice history for this version").selectOption("mex_browser_5");
      await expect(
        page.getByText(/Historical result: its model or strength differs/),
      ).toBeVisible();
      expect(calls).toHaveLength(5);
      await page.reload();
      await page.locator(".advice-option > summary").click();
      await expect(
        page.getByText("SYNTHETIC evaluation-advice deepseek-direct", { exact: true }),
      ).toBeVisible();
      await page.locator(".calibration-option > summary").click();
      await expect(page.getByRole("region", { name: "Prompt text diagnostics" })).toContainText(
        "no model call or fee",
      );
    } else if (scenario.api === "playground") {
      await page.reload();
      await expect(
        page.getByText("SYNTHETIC playground deepseek-ai/DeepSeek-V4-Pro", { exact: true }),
      ).toBeVisible();
      await page
        .locator(".evidence-disclosure")
        .filter({ hasText: "score = null" })
        .locator("summary")
        .click();
      await expect(page.getByText("score = null · grade = null")).toBeVisible();
      await page.goto("/en/app/prompts/prm_writing_course_01/evaluate");
      await page.locator(".calibration-option > summary").click();
      await expect(page.getByText("EXECUTED · UNGRADED", { exact: true })).toBeVisible();
    }
    expect(calls).toHaveLength(5);
  });
}

test("new generation defaults to direct DeepSeek and never silently falls back to simulation", async ({
  page,
}) => {
  const calls: Record<string, unknown>[] = [];
  await page.route("**/api/skills/workflow", (route) => {
    if (route.request().postDataJSON().action === "plan")
      return route.fulfill({ json: singlePlan });
    calls.push(route.request().postDataJSON());
    return route.fulfill({ json: { status: "FAILED", error_code: "SYNTHETIC_FAILURE" } });
  });
  await page.goto("/en/app/generate");
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("deepseek-direct");
  await page.getByLabel("What do you want the AI to do?").fill("Synthetic acceptance prompt");
  const primary = page.getByRole("button", { name: "Generate with DeepSeek · Live", exact: true });
  await expect(primary).toHaveClass(/btn-primary/);
  expect(calls).toHaveLength(0);
  await primary.click();
  const alert = page.getByRole("main").getByRole("alert");
  await alert.getByText("Technical details", { exact: true }).click();
  await expect(alert).toContainText("SYNTHETIC_FAILURE");
  expect(calls).toEqual([
    expect.objectContaining({
      modelKey: "deepseek-direct",
      strength: "off",
    }),
  ]);
  expect(calls[0]).not.toHaveProperty("maxOutputTokens");
  await expect(page.getByRole("link", { name: "Continue editing", exact: true })).toHaveCount(0);
  await page.getByText("Simulation · no model call", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Generate simulated draft", exact: true }),
  ).toBeVisible();
});

const singlePlan = {
  id: "swp_browser",
  analysis: { delivery: "SINGLE_PROMPT", stages: [], matching: { gaps: [], candidates: [] } },
  selections: [
    {
      versionId: "skv_synthetic",
      name: "Synthetic Skill",
      responsibility: "Plan acceptance checks",
      resources: [],
      notes: [],
    },
  ],
};

for (const purpose of ["PROMPT_GENERATION", "OPTIMIZATION"] as const) {
  test(`main task ${purpose} forwards five model selections and restores its saved result (mocked service)`, async ({
    page,
  }) => {
    const snapshot = createInitialState();
    const source = snapshot.versions.find(
      (v) => v.promptId === "prm_writing_course_01" && v.number === 3,
    )!;
    const calls: Record<string, unknown>[] = [];
    const plans: Record<string, unknown>[] = [];
    await page.route("**/api/demo/snapshot", (route) => route.fulfill({ json: snapshot }));
    await page.route("**/api/skills/workflow", (route) => {
      const body = route.request().postDataJSON();
      if (body.action === "plan") {
        plans.push(body);
        return route.fulfill({ json: { ...singlePlan, id: `swp_browser_${plans.length}` } });
      }
      calls.push(body);
      const model = MODEL_CATALOG.find((m) => m.key === body.modelKey)!;
      const generation = purpose === "PROMPT_GENERATION";
      const result = {
        executionMode: "LIVE" as const,
        ...(generation ? { title: "Synthetic plan", taskType: "General" as const } : { purpose }),
        promptId: generation ? `prm_skill_${calls.length}` : source.promptId,
        versionId: generation ? `ver_skill_${calls.length}` : source.id,
        content: `SYNTHETIC Skill ${purpose} ${model.key}`,
        executionId: `mex_skill_${calls.length}`,
        provider: model.provider,
        requestedModel: model.model,
        resolvedModel: model.model,
        productVersion: model.name,
        strength: body.strength,
        optimizationId: `opt_skill_${calls.length}`,
        usage: {
          promptTokens: 20,
          completionTokens: 30,
          totalTokens: 50,
          reasoningTokens: model.defaultStrength === "off" ? 0 : 25,
        },
        latencyMs: 1,
      };
      if (generation) {
        snapshot.prompts.unshift({
          id: result.promptId,
          title: "Synthetic plan",
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
          title: "Synthetic plan",
          content: result.content,
          createdBy: `${model.provider}-live`,
          source: liveSource(model.provider, "GENERATION"),
          createdAt: "2026-11-10",
          modelEvidence: { ...result, strength: model.defaultStrength },
        });
      }
      return route.fulfill({ json: { status: "SUCCEEDED", result } });
    });
    await page.goto(
      purpose === "PROMPT_GENERATION"
        ? "/en/app/generate"
        : "/en/app/prompts/prm_writing_course_01/optimize",
    );
    const panel = page.getByRole("region", { name: "Skills for this task", exact: true });
    await expect(panel).toBeVisible();
    await expect(page.getByLabel("Task goal and explicit constraints")).toHaveCount(0);
    if (purpose === "OPTIMIZATION")
      await expect(page.getByLabel("What do you want the AI to do?")).toHaveCount(0);
    await page.locator(".model-controls > details > summary").click();
    for (const model of MODEL_CATALOG) {
      if (purpose === "PROMPT_GENERATION")
        await page.getByLabel("What do you want the AI to do?").fill(`Synthetic plan ${model.key}`);
      await page.getByLabel("Model", { exact: true }).selectOption(model.key);
      await expect(page.getByLabel("Reasoning strength")).toHaveValue(model.defaultStrength);
      await expect(
        page.getByLabel(
          model.provider === "deepseek" || model.key === "tencent/Hy4-preview"
            ? "Output token budget (includes reasoning)"
            : "Answer token limit (excludes reasoning)",
        ),
      ).toContainText("1200 tokens");
      const before = calls.length;
      expect(plans).toHaveLength(before);
      await page
        .getByRole("button", {
          name: `${purpose === "PROMPT_GENERATION" ? "Generate" : "Optimize"} with ${model.provider === "deepseek" ? "DeepSeek" : model.name} · Live`,
          exact: true,
        })
        .click();
      await expect(
        page
          .getByRole("main")
          .getByText(`SYNTHETIC Skill ${purpose} ${model.key}`, { exact: true }),
      ).toBeVisible();
      expect(calls).toHaveLength(before + 1);
      expect(plans).toHaveLength(before + 1);
      expect(plans.at(-1)).toMatchObject({
        ...(purpose === "PROMPT_GENERATION"
          ? { goal: `Synthetic plan ${model.key}` }
          : { source: { promptId: source.promptId, versionId: source.id } }),
        matchingMode: "AUTO",
        selectedVersionIds: [],
        manualOverride: false,
      });
      expect(calls.at(-1)).toMatchObject({
        action: "run",
        planId: `swp_browser_${plans.length}`,
        purpose,
        modelKey: model.key,
        strength: model.defaultStrength,
      });
      await expect(panel).toContainText("This task references: Synthetic Skill");
      if (purpose === "OPTIMIZATION") {
        expect(plans.at(-1)).not.toHaveProperty("goal");
        expect(calls.at(-1)).toMatchObject({ promptId: source.promptId, versionId: source.id });
        await expect(
          page.getByRole("button", { name: "Save live proposal as new version", exact: true }),
        ).toBeEnabled();
        expect(snapshot.versions.find((v) => v.id === source.id)?.content).toBe(source.content);
      }
    }
    await page.reload();
    if (purpose === "PROMPT_GENERATION") {
      const restore = page.getByRole("button", { name: "Restore saved task result", exact: true });
      if (await restore.isVisible()) await restore.click();
    }
    await expect(
      page
        .getByRole("main")
        .getByText(`SYNTHETIC Skill ${purpose} deepseek-ai/DeepSeek-V4-Pro`, { exact: true }),
    ).toBeVisible();
    const evidence = page
      .locator(".evidence-disclosure")
      .filter({ has: page.locator(".model-result-evidence") })
      .first();
    await evidence.locator("summary").first().click();
    await expect(evidence).toContainText("20 input + 30 output = 50 tokens");
    await expect(evidence).toContainText("DeepSeek-V4-Pro");
    expect(calls).toHaveLength(5);
    expect(plans).toHaveLength(5);
  });
}

for (const preference of ["AUTO", "MANUAL", "NONE"] as const) {
  test(`main task ${preference} keeps one goal and sends the exact reference choice in one click`, async ({
    page,
  }) => {
    const snapshot = createInitialState();
    const plans: Record<string, unknown>[] = [],
      runs: Record<string, unknown>[] = [];
    const skill = {
      versionId: "skv_private_manual",
      name: "Private acceptance method",
      description: "Checks task acceptance",
      personal: true,
    };
    const result = {
      executionMode: "LIVE" as const,
      executionId: "mex_choice",
      promptId: "prm_choice",
      versionId: "ver_choice",
      title: "Choice result",
      taskType: "General" as const,
      content: `SYNTHETIC choice ${preference}`,
      provider: "deepseek" as const,
      requestedModel: "deepseek-flash",
      resolvedModel: "deepseek-flash",
      productVersion: "DeepSeek",
      strength: "off" as const,
      usage: { promptTokens: 20, completionTokens: 30, totalTokens: 50 },
      latencyMs: 1,
    };
    await page.route("**/api/demo/snapshot", (route) => route.fulfill({ json: snapshot }));
    await page.route("**/api/skills/library**", (route) =>
      route.fulfill({
        json: {
          library: [
            { ...skill, versionId: "skv_unselected_shared", name: "Unselected shared method" },
          ],
          personal: [skill],
          user: { role: "USER" },
          totals: { library: 1, personal: 1 },
          pageSize: 25,
        },
      }),
    );
    await page.route("**/api/skills/workflow", (route) => {
      const body = route.request().postDataJSON();
      if (body.action === "plan") {
        plans.push(body);
        return route.fulfill({
          json: {
            ...singlePlan,
            selections:
              preference === "MANUAL"
                ? [{ ...skill, responsibility: "Acceptance checks", resources: [], notes: [] }]
                : [],
          },
        });
      }
      runs.push(body);
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
        createdBy: "deepseek-live",
        source: liveSource("deepseek", "GENERATION"),
        createdAt: "2026-11-10",
        modelEvidence: result,
      });
      return route.fulfill({ json: { status: "SUCCEEDED", result } });
    });
    await page.goto("/en/app/generate");
    const goal = page.getByLabel("What do you want the AI to do?", { exact: true });
    await goal.fill("Keep this exact task goal and acceptance constraint");
    const methods = page.getByRole("region", { name: "Skills for this task", exact: true });
    await methods.getByRole("button", { name: "Adjust", exact: true }).click();
    if (preference === "MANUAL") {
      await methods.getByRole("radio", { name: "Select manually", exact: true }).check();
      await methods.getByRole("checkbox", { name: /Private acceptance method/ }).check();
      await expect(
        methods.getByRole("checkbox", { name: /Unselected shared method/ }),
      ).not.toBeChecked();
    } else if (preference === "NONE") {
      await methods.getByRole("radio", { name: "Do not use Skills", exact: true }).check();
    } else
      await expect(
        methods.getByRole("radio", { name: "Select automatically", exact: true }),
      ).toBeChecked();
    await expect(goal).toHaveValue("Keep this exact task goal and acceptance constraint");
    await expect(page.getByLabel("Task goal and explicit constraints")).toHaveCount(0);
    expect(plans).toHaveLength(0);
    expect(runs).toHaveLength(0);
    await page.getByRole("button", { name: "Generate with DeepSeek · Live", exact: true }).click();
    await expect(page.getByRole("main").getByText(result.content, { exact: true })).toBeVisible();
    expect(plans).toEqual([
      expect.objectContaining({
        action: "plan",
        goal: "Keep this exact task goal and acceptance constraint",
        matchingMode: preference === "AUTO" ? "AUTO" : "MANUAL",
        manualOverride: preference !== "AUTO",
        selectedVersionIds: preference === "MANUAL" ? [skill.versionId] : [],
      }),
    ]);
    expect(runs).toHaveLength(1);
    await expect(methods).toContainText(
      preference === "MANUAL"
        ? "This task references: Private acceptance method"
        : "No Skill used for this task",
    );
    await expect(page.getByRole("region", { name: "Review stage plan", exact: true })).toHaveCount(
      0,
    );
  });
}

test("dependent deliverables require a stage confirmation before the only live dispatch", async ({
  page,
}) => {
  const plans: unknown[] = [],
    runs: unknown[] = [];
  await page.route("**/api/skills/workflow", (route) => {
    const body = route.request().postDataJSON();
    if (body.action === "plan") {
      plans.push(body);
      return route.fulfill({
        json: {
          ...singlePlan,
          analysis: {
            ...singlePlan.analysis,
            delivery: "PROMPT_PACKAGE",
            stages: [
              { name: "Research", input: "Goal", acceptance: "Evidence" },
              { name: "Draft", input: "Research evidence", acceptance: "Complete deliverable" },
            ],
          },
        },
      });
    }
    runs.push(body);
    return route.fulfill({ json: { status: "FAILED", error_code: "SYNTHETIC_FAILURE" } });
  });
  await page.goto("/en/app/generate");
  await page
    .getByLabel("What do you want the AI to do?")
    .fill("Research evidence, then draft a proposal using it");
  await page.getByRole("button", { name: "Generate with DeepSeek · Live", exact: true }).click();
  await expect(page.getByRole("region", { name: "Review stage plan", exact: true })).toContainText(
    "No model call has occurred",
  );
  expect(plans).toHaveLength(1);
  expect(runs).toHaveLength(0);
  await page.getByRole("button", { name: "Confirm stages and generate", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
  expect(plans).toHaveLength(1);
  expect(runs).toHaveLength(1);
});

test("evaluation diagnostics and model history fit small and landscape screens", async ({
  page,
}, testInfo) => {
  await page.route("**/api/demo/snapshot", (route) =>
    route.fulfill({ json: createInitialState() }),
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const viewport of [
    { width: 375, height: 812 },
    { width: 812, height: 375 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/en/app/prompts/prm_writing_course_01/evaluate");
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "20px";
    });
    await page.locator(".calibration-option > summary").click();
    const diagnostics = page.getByRole("region", { name: "Prompt text diagnostics" });
    await expect(diagnostics).toBeVisible();
    const overflow = await page.evaluate(() =>
      [...document.querySelectorAll("main *")]
        .filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
        .map((e) => ({
          tag: e.tagName,
          class: e.className,
          text: e.textContent?.slice(0, 60),
          width: e.getBoundingClientRect().width,
          right: e.getBoundingClientRect().right,
          wrap: getComputedStyle(e).flexWrap,
          parentWidth: e.parentElement?.getBoundingClientRect().width,
          display: getComputedStyle(e).display,
          client: document.documentElement.clientWidth,
          scroll: document.documentElement.scrollWidth,
        }))
        .slice(0, 12),
    );
    expect(overflow).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`evaluation-${viewport.width}.png`),
      fullPage: true,
    });
  }
});
