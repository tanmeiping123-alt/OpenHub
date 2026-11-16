import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

const source = {
  repositoryOwner: "obra",
  repositoryName: "superpowers",
  path: "skills/writing-plans",
  ref: "22f0b463e7a5e579904dd6211a520321035526f7",
};
const skill = {
  versionId: "skv_ui_fixture",
  name: "Synthetic planning skill",
  description: "UI fixture only",
  source,
  manifestSha256: "a".repeat(64),
  warnings: [],
  publicationKind: null,
  submissionId: null,
  submissionStatus: null,
  reviewNote: null,
};
async function setup(page: Page, role: "USER" | "ADMIN", populated = false) {
  const user = { id: "usr_ui_fixture", email: "fixture@example.test", role };
  await page.route("**/api/auth/session", (r) => r.fulfill({ json: { user } }));
  await page.route("**/api/demo/snapshot", (r) =>
    r.fulfill({
      json: {
        prompts: [],
        versions: [],
        reports: [],
        history: [],
        libraryPromptIds: [],
        favorites: [],
        playgroundRuns: [],
        liveAdvice: [],
        profileName: "Fixture user",
      },
    }),
  );
  await page.route("**/api/skills/library", (r) =>
    r.fulfill({
      json: {
        user,
        library: [],
        personal: populated ? [skill] : [],
        pending:
          role === "ADMIN" && populated
            ? [{ ...skill, submissionId: "sls_ui", submissionStatus: "PENDING" }]
            : [],
      },
    }),
  );
}

test("guest is redirected to login and triggers no import or model write", async ({
  page,
  context,
}) => {
  await context.clearCookies();
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/api\/(skills|ai)/.test(r.url())) writes.push(r.url());
  });
  await page.goto("/en/app/skills");
  await expect(page).toHaveURL(/\/en\/login\?/);
  await expect(page.getByRole("heading", { name: "Log in", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Skills library" })).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("personal imports require rights and risk acknowledgement on narrow, landscape and enlarged text", async ({
  page,
}) => {
  await setup(page, "USER");
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const size of [
    { width: 375, height: 812 },
    { width: 812, height: 375 },
  ]) {
    await page.setViewportSize(size);
    await page.goto("/zh-CN/app/skills");
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "20px";
    });
    const panel = page.getByRole("region", { name: "Skills 库" });
    await panel.getByRole("button", { name: "添加 Skill", exact: true }).click();
    await panel.getByLabel("导入方式", { exact: true }).selectOption("AUTHORED");
    await panel.getByLabel("Skill 标识（小写字母、数字及连字符）").fill("test-writing");
    await panel.getByLabel("何时应使用此 Skill？").fill("用于写作");
    await panel.getByLabel("方法、约束、输出及验收要求").fill("保留明确的要求与事实。");
    const button = panel.getByRole("button", { name: "导入供本人使用" });
    await expect(button).toBeDisabled();
    await panel.getByRole("checkbox", { name: /我确认有权保存和使用/ }).check();
    await expect(button).toBeDisabled();
    await panel.getByRole("checkbox", { name: /我确认承担本次内容/ }).check();
    await expect(button).toBeEnabled();
    await expect(panel.getByRole("button", { name: /待审核推荐/ })).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  }
});

async function previewGitHub(page: Page) {
  await page.route("**/api/skills/discover", (r) => r.fulfill({ json: { candidates: [source] } }));
  await page.route("**/api/skills/sources", (r) =>
    r.fulfill({
      json: {
        preparedSourceId: "sps_fixture",
        source,
        preview: {
          name: skill.name,
          description: skill.description,
          body: "SOURCE_PREVIEW_FIXTURE",
          warnings: [],
          resources: [],
        },
      },
    }),
  );
  const panel = page.getByRole("region", { name: "Skills library" });
  await panel.getByRole("button", { name: "Add Skill", exact: true }).click();
  await panel
    .getByLabel("GitHub repository or Skill directory URL")
    .fill("https://github.com/obra/superpowers");
  await panel.getByRole("button", { name: "Preview source" }).click();
  await expect(panel.getByText("Fixed version: " + source.ref)).toBeVisible();
  await panel.getByRole("checkbox", { name: /I have permission/ }).check();
  await panel.getByRole("checkbox", { name: /I accept personal-use risks/ }).check();
  return panel;
}

test("service failure is not shown as an empty library", async ({ page }) => {
  await page.route("**/api/skills/library", (r) =>
    r.fulfill({ status: 503, json: { error: "UNAVAILABLE" } }),
  );
  await page.goto("/en/app/skills");
  await expect(page.getByText("Skills library unavailable. Please retry.")).toBeVisible();
  await expect(page.getByText("No Skills in this section yet.")).toHaveCount(0);
});

test("personal import preserves risk and idempotency across an uncertain result", async ({
  page,
}) => {
  await setup(page, "USER");
  const requests: { key: string; risk: string; body: unknown }[] = [];
  await page.route("**/api/skills/imports", async (r) => {
    requests.push({
      key: r.request().headers()["idempotency-key"],
      risk: r.request().headers()["x-personal-risk-acceptance"],
      body: r.request().postDataJSON(),
    });
    if (requests.length === 1) return r.abort();
    return r.fulfill({ json: { status: "REGISTERED", versionId: skill.versionId } });
  });
  await page.goto("/en/app/skills");
  const panel = await previewGitHub(page);
  await panel.getByRole("button", { name: "Import for personal use" }).click();
  await expect(panel.getByRole("alert")).toBeVisible();
  await panel.getByRole("button", { name: "Reconcile guided import" }).click();
  await expect(panel.getByRole("status")).toContainText("Imported. Only you can use this version");
  expect(requests).toHaveLength(2);
  expect(requests[0].key).toBeTruthy();
  expect(requests[0]).toEqual(requests[1]);
  expect(requests[0].risk).toBe("personal-risk-v1");
  expect(requests[0].body).toEqual({ preparedSourceId: "sps_fixture" });
});

test("ordinary recommendation needs explicit sharing consent", async ({ page }) => {
  await setup(page, "USER", true);
  await page.route("**/api/skills/library?versionId=*", (r) =>
    r.fulfill({
      json: { ...skill, body: "Safe fixture text", resources: [], accessKind: "PERSONAL" },
    }),
  );
  const posts: unknown[] = [];
  await page.route("**/api/skills/library", (r) => {
    if (r.request().method() !== "POST") return r.fallback();
    posts.push(r.request().postDataJSON());
    return r.fulfill({ json: { status: "PENDING" } });
  });
  await page.goto("/en/app/skills");
  const panel = page.getByRole("region", { name: "Skills library" });
  await panel.getByRole("button", { name: "My imports (1)" }).click();
  await panel.getByRole("button", { name: "View content and source" }).click();
  const recommend = panel.getByRole("button", { name: "Recommend to shared library" });
  await expect(recommend).toBeDisabled();
  await panel.getByRole("checkbox", { name: /I recommend this exact version/ }).check();
  await recommend.click();
  await expect(panel.getByRole("status")).toHaveText(
    "Recommended. Waiting for review; this version is still available for your personal use.",
  );
  expect(posts).toEqual([{ action: "recommend", versionId: skill.versionId, shareAccepted: true }]);
});

test("administrator imports directly and can review an exact recommendation", async ({ page }) => {
  await setup(page, "ADMIN", true);
  await page.route("**/api/skills/library?versionId=*", (r) =>
    r.fulfill({
      json: {
        ...skill,
        submissionId: "sls_ui",
        submissionStatus: "PENDING",
        body: "Review fixture",
        resources: [],
        accessKind: "REVIEW_ONLY",
      },
    }),
  );
  const posts: unknown[] = [];
  await page.route("**/api/skills/library", (r) => {
    if (r.request().method() !== "POST") return r.fallback();
    posts.push(r.request().postDataJSON());
    return r.fulfill({ json: { status: "APPROVED" } });
  });
  await page.goto("/en/app/skills");
  const panel = page.getByRole("region", { name: "Skills library" });
  await panel.getByRole("button", { name: "Add Skill", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "Import and publish to all users" }),
  ).toBeDisabled();
  await expect(panel.getByRole("checkbox", { name: /I accept personal-use risks/ })).toHaveCount(0);
  await panel.getByRole("button", { name: "Review queue (1)" }).click();
  await expect(
    panel.getByRole("button", { name: "Use for this generation / optimization" }),
  ).toHaveCount(0);
  await panel.getByRole("button", { name: "View content and source" }).click();
  await expect(panel.getByRole("button", { name: "Approve and publish" })).toBeDisabled();
  await panel.getByLabel("Review note", { exact: true }).fill("Reviewed exact fixture version");
  await panel.getByRole("button", { name: "Approve and publish" }).click();
  await expect(panel.getByRole("status")).toHaveText("Review saved.");
  expect(posts).toEqual([
    {
      action: "review",
      submissionId: "sls_ui",
      decision: "APPROVED",
      note: "Reviewed exact fixture version",
    },
  ]);
});

test("secondary insertion adds authorized text in a new editor draft without executing a model", async ({
  page,
}) => {
  await setup(page, "USER", true);
  await page.route("**/api/skills/library", (r) =>
    r.request().method() === "POST"
      ? r.fulfill({
          json: { ...skill, body: "AUTHORIZED_SKILL_TEXT", resources: [], accessKind: "PERSONAL" },
        })
      : r.fallback(),
  );
  await page.goto("/en/app/editor");
  await page.getByLabel("Prompt title", { exact: true }).fill("Existing unsaved draft");
  await page.getByLabel("Prompt content", { exact: true }).fill("KEEP_EXISTING_DRAFT_TEXT");
  await page.goto("/en/app/skills");
  const panel = page.getByRole("region", { name: "Skills library" });
  await panel.getByRole("button", { name: "My imports (1)" }).click();
  await page.route("**/api/skills/library?versionId=*", (r) =>
    r.fulfill({
      json: { ...skill, body: "AUTHORIZED_SKILL_TEXT", resources: [], accessKind: "PERSONAL" },
    }),
  );
  await panel.getByRole("button", { name: "View content and source" }).click();
  await panel.getByText("Insert original text into a draft", { exact: true }).click();
  await panel.getByRole("button", { name: "Insert original text into draft", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/app\/editor$/);
  await expect(page.getByLabel("Prompt content", { exact: true })).toHaveValue(
    /AUTHORIZED_SKILL_TEXT/,
  );
  await expect(page.getByLabel("Prompt content", { exact: true })).toHaveValue(
    /KEEP_EXISTING_DRAFT_TEXT/,
  );
  await expect(page.getByLabel("Prompt title", { exact: true })).toHaveValue(
    "Existing unsaved draft",
  );
  await page.reload();
  await expect(page.getByLabel("Prompt content", { exact: true })).toHaveValue(
    /AUTHORIZED_SKILL_TEXT/,
  );
});

test("new account empty workspace renders and ignores another account's cached draft", async ({
  page,
}) => {
  await setup(page, "USER");
  await page.addInitScript(() => {
    sessionStorage.setItem(
      "promptmaster-account-another-user",
      JSON.stringify({
        draft: { title: "OTHER_ACCOUNT_PRIVATE", content: "OTHER_ACCOUNT_PRIVATE" },
      }),
    );
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const path of [
    "app",
    "app/account",
    "app/playground",
    "app/execution-evaluation",
    "app/editor",
    "app/settings",
  ]) {
    await page.goto(`/en/${path}`);
    await expect(page.locator("main").first()).toBeVisible();
    await expect(page.getByText("OTHER_ACCOUNT_PRIVATE")).toHaveCount(0);
  }
  expect(errors).toEqual([]);
  await page.goto("/en/app/editor");
  await expect(page.getByLabel("Prompt content", { exact: true })).toHaveValue("");
});

test("confirmed import remains successful if list refresh subsequently fails", async ({ page }) => {
  await setup(page, "USER");
  await page.route("**/api/skills/imports", async (r) => {
    await page.route("**/api/skills/library", (read) =>
      read.fulfill({ status: 503, json: { error: "UNAVAILABLE" } }),
    );
    return r.fulfill({ json: { status: "REGISTERED" } });
  });
  await page.goto("/en/app/skills");
  const panel = await previewGitHub(page);
  await panel.getByRole("button", { name: "Import for personal use" }).click();
  await expect(panel.getByRole("status")).toContainText("Imported. Only you can use this version");
  await expect(panel.getByRole("status")).toContainText("List refresh failed");
});

test("primary Skill action selects the current task without inserting raw text", async ({
  page,
}) => {
  await setup(page, "USER", true);
  const writes: unknown[] = [];
  await page.route("**/api/skills/library", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    writes.push(route.request().postDataJSON());
    return route.fulfill({ status: 400, json: { error: "UNEXPECTED_RAW_ADOPTION" } });
  });
  await page.goto("/en/app/skills");
  const panel = page.getByRole("region", { name: "Skills library" });
  await panel.getByRole("button", { name: "My imports (1)" }).click();
  await panel.getByRole("button", { name: "Use for this generation / optimization" }).click();
  await expect(page).toHaveURL(/\/en\/app\/generate(?:\?|$)/);
  expect(writes).toEqual([]);
  await page.goto("/en/app/editor");
  await expect(page.getByLabel("Prompt content", { exact: true })).toHaveValue("");
});

test("multiple GitHub Skills require a choice before content preview", async ({ page }) => {
  await setup(page, "USER");
  let previews = 0;
  await page.route("**/api/skills/discover", (route) =>
    route.fulfill({ json: { candidates: [source, { ...source, path: "skills/another" }] } }),
  );
  await page.route("**/api/skills/sources", (route) => {
    previews++;
    return route.fulfill({
      json: {
        preparedSourceId: "sps_chosen",
        source: route.request().postDataJSON(),
        preview: {
          name: skill.name,
          description: skill.description,
          body: "CHOSEN_BODY",
          warnings: [],
          resources: [],
        },
      },
    });
  });
  await page.goto("/en/app/skills");
  await page.getByRole("button", { name: "Add Skill", exact: true }).click();
  const panel = page.getByRole("region", { name: "Guided Skill import" });
  await panel
    .getByLabel("GitHub repository or Skill directory URL")
    .fill("https://github.com/obra/superpowers");
  await panel.getByRole("button", { name: "Preview source" }).click();
  await expect(panel.getByRole("button", { name: "Preview: skills/another" })).toBeVisible();
  expect(previews).toBe(0);
  await panel.getByRole("button", { name: "Preview: skills/another" }).click();
  await expect(panel.getByText(/Source: obra\/superpowers\/skills\/another/)).toBeVisible();
  expect(previews).toBe(1);
  await expect(panel.getByRole("button", { name: "Import for personal use" })).toBeDisabled();
});

for (const importState of ["SAME_VERSION", "NEW_VERSION"] as const) {
  test(`GitHub ${importState} shows the version boundary before saving`, async ({ page }) => {
    await setup(page, "USER");
    const writes: unknown[] = [];
    await page.route("**/api/skills/imports", (route) => {
      writes.push(route.request().postDataJSON());
      return route.fulfill({ json: { status: "REGISTERED", versionId: "skv_new" } });
    });
    await page.goto("/en/app/skills");
    await page.route("**/api/skills/discover", (route) =>
      route.fulfill({ json: { candidates: [source] } }),
    );
    await page.route("**/api/skills/sources", (route) =>
      route.fulfill({
        json: {
          preparedSourceId: "sps_boundary",
          source,
          preview: {
            name: skill.name,
            description: skill.description,
            body: "VERSION_BODY",
            warnings: [],
            resources: [],
            importState,
          },
        },
      }),
    );
    await page.getByRole("button", { name: "Add Skill", exact: true }).click();
    const panel = page.getByRole("region", { name: "Guided Skill import" });
    await panel
      .getByLabel("GitHub repository or Skill directory URL")
      .fill("https://github.com/obra/superpowers");
    await panel.getByRole("button", { name: "Preview source" }).click();
    await panel.getByRole("checkbox", { name: /I have permission/ }).check();
    await panel.getByRole("checkbox", { name: /I accept personal-use risks/ }).check();
    if (importState === "SAME_VERSION") {
      await expect(panel.getByText(/This exact version already exists/)).toBeVisible();
      await expect(panel.getByRole("button", { name: "Already imported" })).toBeDisabled();
      expect(writes).toEqual([]);
    } else {
      await expect(panel.getByText(/previous sharing approval does not apply/)).toBeVisible();
      await expect(panel.getByRole("button", { name: "Import for personal use" })).toBeDisabled();
      await panel.getByRole("checkbox", { name: /I reviewed the version change/ }).check();
      await panel.getByRole("button", { name: "Import for personal use" }).click();
      await expect(panel.getByRole("status")).toContainText(
        "Imported. Only you can use this version",
      );
      expect(writes).toEqual([{ preparedSourceId: "sps_boundary" }]);
    }
  });
}
