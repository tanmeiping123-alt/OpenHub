import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
const user = { id: "usr_acceptance_fixture", email: "fixture@example.test", role: "USER" };
const versionId = "skv_11111111-1111-4111-8111-111111111111";
const skill = {
  versionId,
  name: "planning-fixture",
  description: "Plan implementation and checks",
  source: { kind: "OFFLINE" },
  manifestSha256: "a".repeat(64),
  warnings: [],
  publicationKind: null,
  submissionStatus: null,
  reviewNote: null,
};
const snapshot = {
  prompts: [],
  versions: [],
  reports: [],
  history: [],
  libraryPromptIds: [],
  favorites: [],
  playgroundRuns: [],
  liveAdvice: [],
  profileName: "Fixture",
};
async function setup(page: Page) {
  await page.route("**/api/**", (r) =>
    ["GET", "HEAD"].includes(r.request().method()) ? r.continue() : r.abort(),
  );
  await page.route("**/api/auth/session", (r) => r.fulfill({ json: { user } }));
  await page.route("**/api/demo/snapshot", (r) => r.fulfill({ json: snapshot }));
  await page.route("**/api/skills/library", (r) =>
    r.fulfill({
      json: {
        user,
        library: [],
        personal: [skill],
        pending: [],
        history: [],
        totals: { library: 0, personal: 1, pending: 0, history: 0 },
        available: 1,
      },
    }),
  );
}
async function draft(page: Page) {
  await page.goto("/en/app/editor");
  await page.getByLabel("Prompt title", { exact: true }).fill("Acceptance fixture");
  await page.getByLabel("Prompt content", { exact: true }).fill("Retain this draft");
}
test("confirmed create + failed snapshot retains IDs and blocks another create after reload", async ({
  page,
}) => {
  await setup(page);
  let posts = 0;
  await page.route("**/api/prompts", async (r) => {
    posts++;
    await page.route("**/api/demo/snapshot", (s) =>
      s.fulfill({ status: 503, json: { error: "UNAVAILABLE" } }),
    );
    return r.fulfill({
      status: 201,
      json: {
        promptId: "prm_acceptance",
        versionId: "ver_acceptance",
        createdAt: "2026-11-05T00:00:00Z",
      },
    });
  });
  await draft(page);
  await page.getByText("Purposes and tags · optional", { exact: true }).click();
  await page.getByRole("checkbox", { name: "Analyze & research", exact: true }).check();
  await page.getByRole("button", { name: "Save as new Prompt", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open saved Prompt" })).toHaveAttribute(
    "href",
    "/en/app/prompts/prm_acceptance/edit",
  );
  await expect(
    page.getByRole("button", { name: "Save as new Prompt", exact: true }),
  ).toBeDisabled();
  await page.reload();
  await expect(page.getByRole("link", { name: "Open saved Prompt" })).toBeVisible();
  await page.getByText("Purposes and tags · optional", { exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "Analyze & research", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("button", { name: "Save as new Prompt", exact: true }),
  ).toBeDisabled();
  expect(posts).toBe(1);
});
test("unknown create survives reload and reconciles with the same idempotency key", async ({
  page,
}) => {
  await setup(page);
  const requests: { key: string; body: unknown }[] = [];
  await page.route("**/api/prompts", (r) => {
    requests.push({
      key: r.request().headers()["idempotency-key"],
      body: r.request().postDataJSON(),
    });
    return requests.length === 1
      ? r.abort()
      : r.fulfill({
          status: 201,
          json: {
            promptId: "prm_reconciled",
            versionId: "ver_reconciled",
            createdAt: "2026-11-05T00:00:00Z",
          },
        });
  });
  await draft(page);
  await page.getByRole("button", { name: "Save as new Prompt", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reconcile this save" })).toBeEnabled();
  await page.reload();
  await expect(page.getByLabel("Prompt content", { exact: true })).toHaveValue("Retain this draft");
  await page.getByRole("button", { name: "Reconcile this save" }).click();
  await expect(page.getByRole("link", { name: "Open saved Prompt" })).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[0].key).toBeTruthy();
  expect(requests[0]).toEqual(requests[1]);
});
test("definite validation failure remains unsaved and editable", async ({ page }) => {
  await setup(page);
  await page.route("**/api/prompts", (r) =>
    r.fulfill({ status: 400, json: { error: "INVALID_PROMPT_INPUT" } }),
  );
  await draft(page);
  await page.getByRole("button", { name: "Save as new Prompt", exact: true }).click();
  await expect(page.getByLabel("Prompt content", { exact: true })).toBeEnabled();
  await expect(page.getByRole("link", { name: "Open saved Prompt" })).toHaveCount(0);
});
test("authored import retains unknown request and uses existing role policy", async ({ page }) => {
  await setup(page);
  const requests: unknown[] = [];
  await page.route("**/api/skills/offline", (r) => {
    requests.push({
      key: r.request().headers()["idempotency-key"],
      body: r.request().postDataJSON(),
      risk: r.request().headers()["x-personal-risk-acceptance"],
    });
    return requests.length === 1
      ? r.abort()
      : r.fulfill({ json: { status: "REGISTERED", versionId } });
  });
  await page.goto("/en/app/skills");
  await page.getByRole("button", { name: "Add Skill", exact: true }).click();
  const panel = page.getByRole("region", { name: "Guided Skill import" });
  await panel.getByLabel("Import method").selectOption("AUTHORED");
  await panel.getByLabel(/Skill slug/).fill("planning-fixture");
  await panel.getByLabel("When should this Skill be used?").fill("Planning and checks");
  await panel
    .getByLabel("Methods, constraints, output and verification")
    .fill("Preserve explicit constraints and test assumptions");
  await expect(panel.getByRole("button", { name: "Import for personal use" })).toBeDisabled();
  await panel.getByRole("checkbox", { name: /I have permission/ }).check();
  await panel.getByRole("checkbox", { name: /I accept personal-use risks/ }).check();
  await panel.getByRole("button", { name: "Import for personal use" }).click();
  await expect(panel.getByRole("alert")).toBeVisible();
  await page.reload();
  await expect(panel.getByText("Pending request retained for this account")).toBeVisible();
  await panel.getByRole("button", { name: "Reconcile guided import" }).click();
  await expect(panel.getByRole("status")).toContainText("Imported. Only you can use this version");
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
});
test("GitHub link selects fixed candidate, previews before importing and binds risk to source", async ({
  page,
}) => {
  await setup(page);
  const source = {
    repositoryOwner: "fixture",
    repositoryName: "repo",
    path: "skills/planning-fixture",
    ref: "b".repeat(40),
  };
  let imports = 0;
  await page.route("**/api/skills/discover", (r) =>
    r.fulfill({ json: { ref: source.ref, candidates: [source] } }),
  );
  await page.route("**/api/skills/sources", (r) =>
    r.fulfill({
      json: {
        preparedSourceId: "sps_fixture",
        source,
        preview: {
          name: "Planning",
          description: "Test",
          body: "PREVIEW ONLY",
          warnings: [],
          resources: [],
        },
      },
    }),
  );
  await page.route("**/api/skills/imports", (r) => {
    imports++;
    expect(r.request().postDataJSON()).toEqual({ preparedSourceId: "sps_fixture" });
    return r.fulfill({ json: { status: "REGISTERED", versionId } });
  });
  await page.goto("/en/app/skills");
  await page.getByRole("button", { name: "Add Skill", exact: true }).click();
  const panel = page.getByRole("region", { name: "Guided Skill import" });
  await panel
    .getByLabel("GitHub repository or Skill directory URL")
    .fill("https://github.com/fixture/repo");
  await panel.getByRole("button", { name: "Preview source" }).click();
  await expect(panel.getByText("PREVIEW ONLY")).toBeHidden();
  await panel.getByText("View evidence · Source and full text", { exact: true }).click();
  await expect(panel.getByText("PREVIEW ONLY")).toBeVisible();
  expect(imports).toBe(0);
  await panel.getByRole("checkbox", { name: /I have permission/ }).check();
  await panel.getByRole("checkbox", { name: /I accept personal-use risks/ }).check();
  await panel.getByRole("button", { name: "Import for personal use" }).click();
  await expect(panel.getByRole("status")).toContainText("Imported. Only you can use this version");
  expect(imports).toBe(1);
});
test("workflow preserves plan through mode changes, then reconciles one live result with provenance", async ({
  page,
}) => {
  await setup(page);
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("pm-skill-workflow:usr_acceptance_fixture:generate"))
      sessionStorage.setItem(
        "pm-skill-workflow:usr_acceptance_fixture:generate",
        JSON.stringify({
          goal: "Earlier unfinished task",
          taskType: "General",
          matchingMode: "AUTO",
          selected: [],
          responsibilities: {},
          plan: null,
        }),
      );
  });
  let plans = 0;
  const calls: { key: string; body: unknown }[] = [];
  await page.route("**/api/skills/workflow", (r) => {
    const b = r.request().postDataJSON();
    if (b.action === "plan") {
      plans++;
      return r.fulfill({
        json: {
          id: "swp_fixture",
          analysis: {
            delivery: "PROMPT_PACKAGE",
            stages: [{ name: "Requirements", input: "Goal", acceptance: "Checks" }],
            matching: { gaps: ["Confirm environment"], candidates: [] },
          },
          selections: [{ ...skill, responsibility: "Planning", resources: [], notes: [] }],
        },
      });
    }
    calls.push({ key: r.request().headers()["idempotency-key"], body: b });
    return calls.length === 1
      ? r.abort()
      : r.fulfill({
          json: {
            status: "SUCCEEDED",
            result: {
              promptId: "prm_workflow",
              versionId: "ver_workflow",
              content: "ADAPTED OUTPUT",
              executionId: "mex_fixture",
              usage: { totalTokens: 120 },
            },
          },
        });
  });
  await page.route("**/api/skills/provenance?versionId=*", (r) =>
    r.fulfill({
      json: { sources: [{ skillVersionId: versionId, evidenceKind: "MODEL_CONTEXT" }] },
    }),
  );
  await page.goto("/en/app/generate");
  await page.locator(".legacy-skill-recovery > summary").click();
  let panel = page.getByRole("region", { name: "Skills-assisted prompt workflow" });
  await panel.getByLabel("Task goal and explicit constraints").fill("Plan implementation");
  await panel.getByRole("button", { name: "Analyze and preview plan · no model charge" }).click();
  await expect(panel.getByText(/swp_fixture/)).toBeHidden();
  await panel
    .getByText("View evidence · Candidate reasons and unresolved conditions", { exact: true })
    .click();
  await expect(panel.getByText(/swp_fixture/)).toBeVisible();
  const toggle = page.getByRole("button", { name: /^Professional mode · Current:/ });
  await toggle.click();
  await toggle.click();
  expect(plans).toBe(1);
  expect(calls).toHaveLength(0);
  await panel.getByRole("button", { name: "Generate and save with live model" }).click();
  await expect(panel.getByRole("button", { name: "Reconcile live workflow" })).toBeEnabled();
  await page.reload();
  await page.locator(".legacy-skill-recovery > summary").click();
  panel = page.getByRole("region", { name: "Skills-assisted prompt workflow" });
  await panel.getByRole("button", { name: "Reconcile live workflow" }).click();
  await expect(panel.getByText("ADAPTED OUTPUT")).toBeVisible();
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(calls[1]);
  await panel.getByText("View evidence", { exact: true }).click();
  await panel.getByRole("button", { name: "Inspect structured provenance" }).click();
  await expect(panel.locator("pre").filter({ hasText: "MODEL_CONTEXT" })).toBeVisible();
});
test("guided forms fit narrow and landscape layouts with enlarged text", async ({
  page,
}, testInfo) => {
  await setup(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const size of [
    { width: 375, height: 812 },
    { width: 812, height: 375 },
  ]) {
    await page.setViewportSize(size);
    await page.goto("/zh-CN/app/skills");
    await page.evaluate(() => (document.documentElement.style.fontSize = "20px"));
    await page.getByRole("button", { name: "添加 Skill", exact: true }).click();
    const panel = page.getByRole("region", { name: "引导式 Skill 导入" });
    await panel.getByLabel("导入方式").selectOption("AUTHORED");
    await panel.getByLabel(/Skill 标识/).fill("planning-fixture");
    await panel.getByLabel("何时应使用此 Skill？").fill("实施和验收");
    await panel.getByLabel("方法、约束、输出及验收要求").fill("保留约束并明确验收标准");
    await panel.getByRole("checkbox", { name: /我确认有权保存/ }).check();
    await panel.getByRole("checkbox", { name: /我确认承担本次/ }).check();
    await expect(panel.getByRole("button", { name: "导入供本人使用" })).toBeVisible();
    await panel.getByRole("button", { name: "导入供本人使用" }).click({ trial: true });
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`guided-${size.width}.png`) });
  }
});

test("SKILL.md upload retains explicit files and resets risk after source editing", async ({
  page,
}) => {
  await setup(page);
  let posted: { origin: string; files: { path: string; content: string }[] } | undefined;
  await page.route("**/api/skills/offline", (r) => {
    posted = r.request().postDataJSON();
    return r.fulfill({ json: { status: "REGISTERED", versionId } });
  });
  await page.goto("/en/app/skills");
  await page.getByRole("button", { name: "Add Skill", exact: true }).click();
  const panel = page.getByRole("region", { name: "Guided Skill import" });
  await panel.getByLabel("Import method").selectOption("UPLOAD");
  await panel.getByLabel(/Skill slug/).fill("planning-fixture");
  await panel.getByLabel("SKILL.md (UTF-8)", { exact: true }).setInputFiles({
    name: "SKILL.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "---\nname: planning-fixture\ndescription: Planning\n---\nUse [checks](references/checks.md)",
    ),
  });
  await expect(panel.getByLabel("Relative resource path 1")).toHaveValue("SKILL.md");
  await panel.getByRole("checkbox", { name: /I have permission/ }).check();
  await panel.getByRole("checkbox", { name: /I accept personal-use risks/ }).check();
  await panel.getByLabel(/Skill slug/).fill("planning-updated");
  await expect(panel.getByRole("button", { name: "Import for personal use" })).toBeDisabled();
  await panel.getByRole("checkbox", { name: /I have permission/ }).check();
  await panel.getByRole("checkbox", { name: /I accept personal-use risks/ }).check();
  await panel.getByRole("button", { name: "Import for personal use" }).click();
  await expect(panel.getByRole("status")).toContainText("Imported. Only you can use this version");
  expect(posted?.origin).toBe("UPLOAD");
  expect(posted?.files[0].path).toBe("SKILL.md");
});

test("administrator withdraws an exact version with reason and can inspect history", async ({
  page,
}) => {
  await setup(page);
  const admin = { ...user, role: "ADMIN" };
  const published = { ...skill, publicationKind: "ADMIN_IMPORT" };
  const writes: unknown[] = [];
  await page.route("**/api/auth/session", (r) => r.fulfill({ json: { user: admin } }));
  await page.route("**/api/skills/library", (r) => {
    if (r.request().method() === "POST") {
      writes.push(r.request().postDataJSON());
      return r.fulfill({ json: { status: "WITHDRAWN" } });
    }
    return r.fulfill({
      json: {
        user: admin,
        library: [published],
        personal: [],
        pending: [],
        history: [],
        totals: { library: 1, personal: 0, pending: 0, history: 0 },
        available: 1,
      },
    });
  });
  await page.route("**/api/skills/library?versionId=*", (r) =>
    r.fulfill({ json: { ...published, body: "FIXTURE", resources: [], accessKind: "SHARED" } }),
  );
  await page.goto("/en/app/skills");
  const panel = page.getByRole("region", { name: "Skills library" });
  await panel.getByRole("button", { name: "View content and source" }).click();
  await expect(panel.getByRole("button", { name: "Confirm withdrawal" })).toBeDisabled();
  await panel
    .getByLabel("Reason for withdrawing this exact shared version")
    .fill("Needs security review");
  await panel.getByRole("button", { name: "Confirm withdrawal" }).click();
  await expect(panel.getByRole("status")).toHaveText("Shared version withdrawn. History retained.");
  expect(writes).toEqual([{ action: "withdraw", versionId, reason: "Needs security review" }]);
  await panel.getByRole("button", { name: /Review \/ withdrawal history/ }).click();
  await expect(panel.getByText("No Skills in this section yet.")).toBeVisible();
});

test("Skill optimization remains a proposal until explicit Apply and saved editor shows independent provenance", async ({
  page,
}) => {
  await setup(page);
  const promptId = "prm_opt_fixture",
    baseId = "ver_opt_base",
    savedId = "ver_opt_saved";
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("pm-skill-workflow:usr_acceptance_fixture:prm_opt_fixture"))
      sessionStorage.setItem(
        "pm-skill-workflow:usr_acceptance_fixture:prm_opt_fixture",
        JSON.stringify({
          goal: "Earlier optimization task",
          taskType: "Writing",
          matchingMode: "AUTO",
          selected: [],
          responsibilities: {},
          plan: null,
        }),
      );
  });
  const prompt = {
    id: promptId,
    title: "Fixture",
    taskType: "Writing",
    currentVersionId: baseId,
    kind: "PERSONAL_PROMPT",
    description: "",
    favorite: false,
  };
  const base = {
    id: baseId,
    promptId,
    number: 1,
    content: "ORIGINAL",
    title: "Fixture",
    createdBy: "Fixture",
    source: "MANUAL_DRAFT",
    createdAt: "2026-11-05T00:00:00Z",
  };
  let applied = false;
  const writes: unknown[] = [];
  await page.route("**/api/demo/snapshot", (r) =>
    r.fulfill({
      json: {
        ...snapshot,
        prompts: [{ ...prompt, currentVersionId: applied ? savedId : baseId }],
        versions: applied
          ? [
              base,
              {
                ...base,
                id: savedId,
                number: 2,
                content: "PROPOSAL WITHOUT EDITABLE SOURCE MARKER",
              },
            ]
          : [base],
      },
    }),
  );
  await page.route("**/api/skills/workflow", (r) => {
    const body = r.request().postDataJSON();
    return r.fulfill({
      json:
        body.action === "plan"
          ? {
              id: "swp_opt_fixture",
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
                promptId,
                versionId: baseId,
                optimizationId: "opt_proof",
                content: "PROPOSAL WITHOUT EDITABLE SOURCE MARKER",
                executionId: "mex_opt",
                usage: { totalTokens: 100 },
              },
            },
    });
  });
  await page.route(`**/api/prompts/${promptId}/versions`, (r) => {
    writes.push(r.request().postDataJSON());
    applied = true;
    return r.fulfill({ status: 201, json: { versionId: savedId } });
  });
  await page.route("**/api/skills/provenance?versionId=*", (r) =>
    r.fulfill({
      json: {
        versionId: savedId,
        sources: [
          {
            skillVersionId: versionId,
            name: skill.name,
            evidenceKind: "MODEL_CONTEXT",
            manifestSha256: skill.manifestSha256,
            resources: [
              { path: "references/checks.md", sha256: "c".repeat(64), type: "REFERENCE" },
            ],
            planId: "swp_opt_fixture",
            executionId: "mex_opt",
          },
        ],
      },
    }),
  );
  await page.goto(`/en/app/prompts/${promptId}/optimize`);
  await page.locator(".legacy-skill-recovery > summary").click();
  const panel = page.getByRole("region", { name: "Skills-assisted prompt workflow" });
  await panel.getByLabel("Task goal and explicit constraints").fill("Improve clarity");
  await panel.getByRole("button", { name: "Analyze and preview plan · no model charge" }).click();
  await panel.getByRole("button", { name: "Create live Skill optimization proposal" }).click();
  await expect(
    panel.locator("pre").filter({ hasText: "PROPOSAL WITHOUT EDITABLE SOURCE MARKER" }),
  ).toBeVisible();
  expect(writes).toHaveLength(0);
  await panel.getByText("View evidence", { exact: true }).click();
  await expect(panel.getByRole("button", { name: "Inspect structured provenance" })).toBeDisabled();
  await panel.getByRole("button", { name: "Apply proposal as new version" }).click();
  await expect(panel.getByRole("link", { name: "Open saved result" })).toBeVisible();
  expect(writes).toEqual([
    {
      content: "PROPOSAL WITHOUT EDITABLE SOURCE MARKER",
      baseVersionId: baseId,
      parentVersionId: baseId,
      source: "SKILL_LIVE_OPTIMIZATION",
      optimizationId: "opt_proof",
    },
  ]);
  await panel.getByRole("link", { name: "Open saved result" }).click();
  await page
    .getByText("View evidence · Structured Skill provenance for this saved version", {
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "Load saved provenance" }).click();
  await expect(page.getByText("planning-fixture · MODEL_CONTEXT")).toBeVisible();
  await expect(page.getByText(/references\/checks.md/)).toBeVisible();
});
