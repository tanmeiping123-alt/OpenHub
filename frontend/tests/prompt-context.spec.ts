import { test, expect } from "./fixtures";
import { createInitialState } from "../src/lib/fixtures";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/ai/**", (r) => r.abort());
  await page.route("**/api/skills/workflow**", (r) => r.abort());
});
test("historical actions keep the same source version and invalid targets never fall back", async ({
  page,
}) => {
  const s = createInitialState();
  const p = s.prompts.find((p) => p.id === "prm_writing_course_01")!;
  const v = s.versions.find((v) => v.promptId === p.id && v.id !== p.currentVersionId)!;
  await page.goto(`/en/app/prompts/${p.id}/edit?versionId=${v.id}`);
  await expect(page.getByLabel("Prompt content", { exact: true })).toHaveValue(v.content);
  const actions = page.getByRole("navigation", { name: "Current Prompt actions" });
  for (const [label, suffix] of [
    ["Evaluate", "evaluate"],
    ["Optimize", "optimize"],
  ]) {
    await expect(actions.getByRole("link", { name: label, exact: true })).toHaveAttribute(
      "href",
      `/en/app/prompts/${p.id}/${suffix}?versionId=${v.id}`,
    );
  }
  await actions.getByRole("link", { name: "Evaluate", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`versionId=${v.id}$`));
  await expect(page.locator(".prompt-context-identity")).toContainText(`v${v.number}`);
  await page.goto(`/en/app/prompts/${p.id}/edit?versionId=missing`);
  await expect(page.getByRole("heading", { name: "Prompt or version unavailable" })).toBeVisible();
  await page.goto("/en/app/playground?promptId=missing&versionId=missing");
  await expect(page.getByRole("heading", { name: "Prompt or version unavailable" })).toBeVisible();
});

test("cleared drafts survive a different Prompt target until explicit discard", async ({
  page,
}) => {
  const s = createInitialState();
  const first = s.prompts.find((p) => p.id === "prm_writing_course_01")!;
  const other = s.prompts.find((p) => p.id !== first.id)!;
  const version = s.versions.find((v) => v.id === other.currentVersionId)!;
  await page.goto(`/en/app/prompts/${first.id}/edit`);
  await page.getByLabel("Prompt content", { exact: true }).fill("");
  await page.goto(`/en/app/prompts/${other.id}/edit`);
  await expect(page.getByRole("heading", { name: "Keep your current draft?" })).toBeVisible();
  await page.getByRole("link", { name: "Return to draft" }).click();
  await expect(page.getByLabel("Prompt content", { exact: true })).toHaveValue("");
  await page.goto(`/en/app/prompts/${other.id}/edit`);
  await page.getByRole("button", { name: "Discard draft and open" }).click();
  await expect(page.getByLabel("Prompt content", { exact: true })).toHaveValue(version.content);
});

test("optimization stays a proposal and saving carries its exact source while keeping another draft", async ({
  page,
}) => {
  const snapshot = createInitialState();
  const draftPrompt = snapshot.prompts.find((p) => p.id === "prm_writing_course_01")!;
  const target = snapshot.prompts.find((p) => p.id !== draftPrompt.id)!;
  const version = snapshot.versions.find((v) => v.id === target.currentVersionId)!;
  await page.route("**/api/demo/snapshot", (r) => r.fulfill({ json: snapshot }));
  await page.route("**/api/models", (r) =>
    r.fulfill({
      json: { models: [{ key: "deepseek-direct", configured: true, maxOutputTokens: 393216 }] },
    }),
  );
  await page.route("**/api/skills/workflow", (r) => {
    if (r.request().postDataJSON().action === "plan")
      return r.fulfill({
        json: {
          id: "swp_isolation",
          analysis: { delivery: "SINGLE_PROMPT", stages: [] },
          selections: [],
        },
      });
    return r.fulfill({
      json: {
        status: "SUCCEEDED",
        result: {
          executionMode: "LIVE",
          purpose: "OPTIMIZATION",
          executionId: "mex_isolation",
          promptId: target.id,
          versionId: version.id,
          content: "Independent optimized proposal",
          provider: "deepseek",
          requestedModel: "deepseek-flash",
          resolvedModel: "deepseek-flash",
          productVersion: "DeepSeek",
          usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
          latencyMs: 1,
          optimizationId: "opt_isolation",
        },
      },
    });
  });
  let saveBody: Record<string, unknown> | undefined;
  await page.route("**/api/prompts/*/versions", (r) => {
    saveBody = r.request().postDataJSON();
    return r.fulfill({ json: { promptId: target.id, versionId: "ver_saved_isolation" } });
  });
  await page.goto(`/en/app/prompts/${draftPrompt.id}/edit`);
  await page.getByLabel("Prompt content", { exact: true }).fill("Keep this independent draft");
  await page.goto(`/en/app/prompts/${target.id}/optimize?versionId=${version.id}`);
  await page.getByRole("button", { name: "Optimize with DeepSeek · Live", exact: true }).click();
  await expect(page.getByText("Independent optimized proposal", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Save live proposal as new version", exact: true })
    .click();
  await expect
    .poll(() => saveBody)
    .toMatchObject({
      title: version.title,
      baseVersionId: version.id,
      parentVersionId: version.id,
      optimizationId: "opt_isolation",
      content: "Independent optimized proposal",
    });
  await page.goto(`/en/app/prompts/${draftPrompt.id}/edit`);
  await expect(page.getByLabel("Prompt content", { exact: true })).toHaveValue(
    "Keep this independent draft",
  );
});

test("saving a historical edit keeps its parent and opens the newly saved version", async ({
  page,
}) => {
  const snapshot = createInitialState();
  const prompt = snapshot.prompts.find((p) => p.id === "prm_writing_course_01")!;
  const originalCurrent = prompt.currentVersionId;
  const history = snapshot.versions.find(
    (v) => v.promptId === prompt.id && v.id !== originalCurrent,
  )!;
  await page.route("**/api/demo/snapshot", (r) => r.fulfill({ json: snapshot }));
  let saveBody: Record<string, unknown> | undefined;
  await page.route("**/api/prompts/*/versions", (r) => {
    saveBody = r.request().postDataJSON();
    snapshot.versions.unshift({
      ...history,
      id: "ver_historical_saved",
      number: 4,
      title: String(saveBody!.title),
      content: String(saveBody!.content),
      parentVersionId: history.id,
    });
    prompt.currentVersionId = "ver_historical_saved";
    prompt.title = String(saveBody!.title);
    return r.fulfill({ json: { promptId: prompt.id, versionId: prompt.currentVersionId } });
  });
  await page.goto(`/en/app/prompts/${prompt.id}/edit?versionId=${history.id}`);
  await page.getByLabel("Prompt content", { exact: true }).fill("Edited historical version");
  await page.getByRole("button", { name: "Save new version", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/app/prompts/${prompt.id}/edit$`));
  expect(saveBody).toMatchObject({
    baseVersionId: originalCurrent,
    parentVersionId: history.id,
    source: "MANUAL_EDIT",
  });
  await expect(page.getByLabel("Prompt content", { exact: true })).toHaveValue(
    "Edited historical version",
  );
  await expect(page.locator(".prompt-context-identity")).toContainText("v4");
});
