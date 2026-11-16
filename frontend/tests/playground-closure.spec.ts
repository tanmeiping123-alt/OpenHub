import { test, expect } from "./fixtures";
import { createInitialState } from "../src/lib/fixtures";
import { MODEL_CATALOG, liveSource } from "../src/lib/model-catalog";
import { createTestAccount, cleanupTestAccount } from "../scripts/test-account.mjs";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/ai/**", (r) => r.abort());
  await page.route("**/api/models", (r) =>
    r.fulfill({
      json: {
        models: MODEL_CATALOG.map((m) => ({
          key: m.key,
          configured: true,
          maxOutputTokens: 1200,
          timeoutMs: 30000,
        })),
      },
    }),
  );
});

function resultFor(input: Record<string, unknown>, sequence = 1) {
  const model = MODEL_CATALOG.find((m) => m.key === input.modelKey) ?? MODEL_CATALOG[0];
  return {
    executionMode: "LIVE" as const,
    purpose: "PLAYGROUND" as const,
    executionId: `mex_closure_${sequence}`,
    sessionId: `pls_closure_${sequence}`,
    promptId: input.promptId as string,
    versionId: input.versionId as string,
    content: `Synthetic execution result ${sequence}`,
    provider: model.provider,
    requestedModel: model.model,
    resolvedModel: model.model,
    productVersion: model.name,
    strength: input.strength,
    usage: { promptTokens: 20, completionTokens: 30, totalTokens: 50 },
    latencyMs: 425,
    finishReason: "length",
    createdAt: "2026-11-10T07:00:00.000Z",
  };
}

test("selects an exact saved version and retains a successful output when workspace refresh fails", async ({
  page,
}) => {
  const snapshot = createInitialState();
  let failSnapshot = false;
  const calls: Record<string, unknown>[] = [];
  await page.route("**/api/demo/snapshot", (r) =>
    failSnapshot
      ? r.fulfill({ status: 503, json: { error: "SYNTHETIC_SNAPSHOT_FAILURE" } })
      : r.fulfill({ json: snapshot }),
  );
  await page.route("**/api/ai/playground", (r) => {
    const body = r.request().postDataJSON();
    calls.push(body);
    failSnapshot = true;
    return r.fulfill({ status: 201, json: resultFor(body) });
  });
  await page.goto("/en/app/playground");
  await page.getByLabel("Saved Prompt", { exact: true }).selectOption("prm_writing_course_01");
  const versions = snapshot.versions.filter((v) => v.promptId === "prm_writing_course_01");
  await page.getByLabel("Saved version", { exact: true }).selectOption(versions[0].id);
  expect(calls).toHaveLength(0);
  await page.getByRole("button", { name: "Run DeepSeek · Live", exact: true }).click();
  await expect(page.getByText("Synthetic execution result 1", { exact: true })).toBeVisible();
  await expect(page.getByText(/workspace refresh failed/i)).toBeVisible();
  await expect(page.getByText(/output.*limit.*may be incomplete/i)).toBeVisible();
  await expect(page.getByText(/50 tokens/, { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy body", exact: true })).toBeVisible();
  expect(calls).toEqual([
    expect.objectContaining({
      promptId: "prm_writing_course_01",
      versionId: versions[0].id,
      requestKey: expect.any(String),
    }),
  ]);
});

test("recovers a lost response after reload using GET only and keeps fixed settings", async ({
  page,
}) => {
  const snapshot = createInitialState();
  let saved: ReturnType<typeof resultFor> | undefined;
  const posts: Record<string, unknown>[] = [],
    gets: string[] = [];
  await page.route("**/api/demo/snapshot", (r) => r.fulfill({ json: snapshot }));
  await page.route("**/api/ai/playground**", (r) => {
    if (r.request().method() === "GET") {
      gets.push(r.request().url());
      return r.fulfill({
        json: { status: "SUCCEEDED", executionId: saved!.executionId, result: saved },
      });
    }
    const input = r.request().postDataJSON();
    posts.push(input);
    saved = resultFor(input);
    return r.abort("failed");
  });
  await page.goto("/en/app/playground");
  await page.getByRole("button", { name: "Run DeepSeek · Live", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Check original request", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Run DeepSeek · Live", exact: true }),
  ).toBeDisabled();
  await page.reload();
  await expect(page.getByText("Synthetic execution result 1", { exact: true })).toBeVisible();
  expect(posts).toHaveLength(1);
  expect(gets).toHaveLength(1);
  expect(new URL(gets[0]).searchParams.get("requestKey")).toBe(posts[0].requestKey);
});

test("history is isolated by saved version and real evidence survives simulation", async ({
  page,
}) => {
  const snapshot = createInitialState();
  const versions = snapshot.versions.filter((v) => v.promptId === "prm_writing_course_01");
  snapshot.playgroundRuns = [1, 2].map((n) => ({
    id: `pls_history_${n}`,
    versionId: versions[0].id,
    source: liveSource("deepseek", "PLAYGROUND"),
    executionId: `mex_history_${n}`,
    outputs: [
      {
        name: "DeepSeek",
        text: `History output ${n}`,
        source: liveSource("deepseek", "PLAYGROUND"),
      },
    ],
  }));
  await page.route("**/api/demo/snapshot", (r) => r.fulfill({ json: snapshot }));
  await page.goto("/en/app/playground");
  await page.getByLabel("Saved Prompt", { exact: true }).selectOption("prm_writing_course_01");
  await page.getByLabel("Saved version", { exact: true }).selectOption(versions[0].id);
  await expect(page.getByText("History output 1", { exact: true })).toBeVisible();
  await page
    .getByLabel("Run history for this version", { exact: true })
    .selectOption("pls_history_2");
  await expect(page.getByText("History output 2", { exact: true })).toBeVisible();
  await page.getByLabel("Saved version", { exact: true }).selectOption(versions[1].id);
  await expect(page.getByText("History output 2", { exact: true })).toHaveCount(0);
  await expect(page.getByText("No real run for this version", { exact: true })).toBeVisible();
});

test("unknown and pending requests stay locked; NOT_FOUND resumes the exact original body only on click", async ({
  page,
}) => {
  const snapshot = createInitialState();
  const posts: Record<string, unknown>[] = [];
  let status = "PENDING";
  await page.route("**/api/demo/snapshot", (r) => r.fulfill({ json: snapshot }));
  await page.route("**/api/ai/playground**", (r) => {
    if (r.request().method() === "GET")
      return r.fulfill({
        json: status === "NOT_FOUND" ? { status } : { status, executionId: "mex_pending" },
      });
    posts.push(r.request().postDataJSON());
    return posts.length === 1 ? r.abort() : r.fulfill({ json: resultFor(posts[1]) });
  });
  await page.goto("/en/app/playground");
  const button = page.getByRole("button", { name: "Run DeepSeek · Live", exact: true });
  await button.evaluate((b: HTMLButtonElement) => {
    b.click();
    b.click();
  });
  await expect(
    page.getByRole("button", { name: "Check original request", exact: true }),
  ).toBeEnabled();
  expect(posts).toHaveLength(1);
  await expect(page.getByLabel("Model", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Saved version", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Check original request", exact: true }).click();
  await expect(page.getByText(/original request is still pending/)).toBeVisible();
  await expect(button).toBeDisabled();
  status = "NOT_FOUND";
  await page.getByRole("button", { name: "Check original request", exact: true }).click();
  const resume = page.getByRole("button", {
    name: "Continue original request · may charge",
    exact: true,
  });
  await expect(resume).toBeVisible();
  expect(posts).toHaveLength(1);
  await resume.click();
  await expect(page.getByText("Synthetic execution result 1", { exact: true })).toBeVisible();
  expect(posts).toHaveLength(2);
  expect(posts[1]).toEqual(posts[0]);
});

test("failed execution requires a cost acknowledgement before a new key can be created", async ({
  page,
}) => {
  const posts: Record<string, unknown>[] = [];
  await page.route("**/api/demo/snapshot", (r) => r.fulfill({ json: createInitialState() }));
  await page.route("**/api/ai/playground**", (r) => {
    if (r.request().method() === "GET")
      return r.fulfill({
        json: { status: "FAILED", executionId: "mex_failed", errorCode: "MODEL_REQUEST_TIMEOUT" },
      });
    posts.push(r.request().postDataJSON());
    return r.fulfill({
      status: 504,
      json: { error: "MODEL_REQUEST_TIMEOUT", message: "Synthetic timeout" },
    });
  });
  await page.goto("/en/app/playground");
  const button = page.getByRole("button", { name: "Run DeepSeek · Live", exact: true });
  await button.click();
  await page.getByRole("button", { name: "Check original request", exact: true }).click();
  const allow = page.getByRole("button", { name: "Allow a new run", exact: true });
  await expect(allow).toBeDisabled();
  await expect(page.getByText("No real run for this version", { exact: true })).toBeVisible();
  await page
    .getByRole("checkbox", { name: "I have checked usage and pending costs", exact: true })
    .check();
  await allow.click();
  expect(posts).toHaveLength(1);
  await button.click();
  await expect(
    page.getByRole("button", { name: "Check original request", exact: true }),
  ).toBeVisible();
  expect(posts).toHaveLength(2);
  expect(posts[1].requestKey).not.toBe(posts[0].requestKey);
});

test("a failed recheck revokes an earlier NOT_FOUND continuation until status is known again", async ({
  page,
}) => {
  let checks = 0,
    posts = 0;
  await page.route("**/api/demo/snapshot", (r) => r.fulfill({ json: createInitialState() }));
  await page.route("**/api/ai/playground**", (r) => {
    if (r.request().method() === "POST") {
      posts++;
      return r.abort();
    }
    checks++;
    return checks === 1 ? r.fulfill({ json: { status: "NOT_FOUND" } }) : r.abort();
  });
  await page.goto("/en/app/playground");
  await page.getByRole("button", { name: "Run DeepSeek · Live", exact: true }).click();
  const check = page.getByRole("button", { name: "Check original request", exact: true });
  await check.click();
  await expect(
    page.getByRole("button", { name: "Continue original request · may charge", exact: true }),
  ).toBeVisible();
  await check.click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("NETWORK_ERROR");
  await expect(
    page.getByRole("button", { name: "Continue original request · may charge", exact: true }),
  ).toHaveCount(0);
  expect(posts).toBe(1);
});

test("session-storage failure blocks paid dispatch", async ({ page }) => {
  let posts = 0;
  await page.route("**/api/demo/snapshot", (r) => r.fulfill({ json: createInitialState() }));
  await page.route("**/api/ai/playground**", (r) => {
    posts++;
    return r.abort();
  });
  await page.goto("/en/app/playground");
  const button = page.getByRole("button", { name: "Run DeepSeek · Live", exact: true });
  await expect(button).toBeEnabled();
  await page.evaluate(() => {
    const old = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("pm-playground:")) throw Error("Synthetic storage blocked");
      return old.call(this, key, value);
    };
  });
  await button.click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Request recovery could not be saved",
  );
  expect(posts).toBe(0);
});

test("unsaved editor content stays a draft while the saved snapshot is executed", async ({
  page,
  testAccount,
}) => {
  const snapshot = createInitialState();
  const version = snapshot.versions.find(
    (v) => v.promptId === "prm_writing_course_01" && v.number === 3,
  )!;
  const draft = {
    ...snapshot.draft,
    promptId: version.promptId,
    parentVersionId: version.id,
    content: "UNSAVED private editor changes",
  };
  await page.addInitScript(
    ({ accountId, saved }) => {
      sessionStorage.setItem(`promptmaster-account-${accountId}`, JSON.stringify(saved));
    },
    { accountId: testAccount.id, saved: { ...snapshot, draft } },
  );
  await page.route("**/api/demo/snapshot", (r) => r.fulfill({ json: snapshot }));
  const posts: Record<string, unknown>[] = [];
  await page.route("**/api/ai/playground", (r) => {
    posts.push(r.request().postDataJSON());
    return r.fulfill({ json: resultFor(posts[0]) });
  });
  await page.goto("/en/app/playground");
  await expect(page.getByText(/You have unsaved edits/)).toBeVisible();
  await expect(page.getByText(version.content, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Run DeepSeek · Live", exact: true }).click();
  await expect(page.getByText("Synthetic execution result 1", { exact: true })).toBeVisible();
  expect(posts).toEqual([expect.objectContaining({ versionId: version.id })]);
  expect(posts[0]).not.toHaveProperty("content");
  expect(
    await page.evaluate(
      (id) => JSON.parse(sessionStorage.getItem(`promptmaster-account-${id}`)!).draft.content,
      testAccount.id,
    ),
  ).toBe(draft.content);
});

test("a source mismatch leaves the original request pending and cannot display foreign output", async ({
  page,
}) => {
  await page.route("**/api/demo/snapshot", (r) => r.fulfill({ json: createInitialState() }));
  let posts = 0;
  await page.route("**/api/ai/playground", (r) => {
    posts++;
    return r.fulfill({
      json: { ...resultFor(r.request().postDataJSON()), versionId: "foreign-version" },
    });
  });
  await page.goto("/en/app/playground");
  const run = page.getByRole("button", { name: "Run DeepSeek · Live", exact: true });
  await run.click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("could not be reconciled");
  await expect(run).toBeDisabled();
  await expect(page.getByText("Synthetic execution result 1", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Check original request", exact: true }),
  ).toBeVisible();
  expect(posts).toBe(1);
});

test("account switching isolates pending receipts and restores only the original account key", async ({
  page,
  context,
  testAccount,
}) => {
  const other = await createTestAccount();
  try {
    let posts = 0;
    const checks: string[] = [];
    await page.route("**/api/demo/snapshot", (r) => r.fulfill({ json: createInitialState() }));
    await page.route("**/api/ai/playground**", (r) => {
      if (r.request().method() === "POST") {
        posts++;
        return r.abort();
      }
      checks.push(new URL(r.request().url()).searchParams.get("requestKey")!);
      return r.fulfill({ json: { status: "PENDING", executionId: "mex_original_account" } });
    });
    await page.goto("/en/app/playground");
    await page.getByRole("button", { name: "Run DeepSeek · Live", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Check original request", exact: true }),
    ).toBeVisible();
    const originalKey = await page.evaluate(
      (id) => JSON.parse(sessionStorage.getItem(`pm-playground:${id}`)!).pending.requestKey,
      testAccount.id,
    );
    const changeAccount = async (token: string) => {
      await context.clearCookies();
      await context.addCookies([
        {
          name: "pm_session",
          value: token,
          domain: "127.0.0.1",
          path: "/",
          httpOnly: true,
          sameSite: "Strict",
        },
      ]);
      await page.reload();
    };
    await changeAccount(other.token);
    await expect(
      page.getByRole("button", { name: "Run DeepSeek · Live", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Check original request", exact: true }),
    ).toHaveCount(0);
    expect(checks).toHaveLength(0);
    await changeAccount(testAccount.token);
    await expect(page.getByText(/original request is still pending/)).toBeVisible();
    expect(checks).toEqual([originalKey]);
    expect(posts).toBe(1);
  } finally {
    await cleanupTestAccount(other);
  }
});

test("selected historical version opens its own execution report without overwriting an editor draft", async ({
  page,
}) => {
  const snapshot = createInitialState();
  const versions = snapshot.versions.filter((v) => v.promptId === "prm_writing_course_01");
  await page.route("**/api/demo/snapshot", (r) => r.fulfill({ json: snapshot }));
  await page.goto(
    "/en/app/playground?promptId=prm_writing_course_01&versionId=ver_writing_course_03",
  );
  await page.getByLabel("Saved version", { exact: true }).selectOption(versions.at(-1)!.id);
  await page.getByRole("link", { name: "Open execution report", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Evaluation report", exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("versionId")).toBe(versions.at(-1)!.id);
  await expect(page.locator(".page-heading")).toContainText(`v${versions.at(-1)!.number}`);
});

test("real history stays visible after a simulation and selected history survives reload", async ({
  page,
}) => {
  const snapshot = createInitialState();
  const version = snapshot.versions.find(
    (v) => v.promptId === "prm_writing_course_01" && v.number === 3,
  )!;
  snapshot.playgroundRuns = [1, 2].map((n) => ({
    id: `pls_visible_${n}`,
    versionId: version.id,
    source: liveSource("deepseek", "PLAYGROUND"),
    executionId: `mex_visible_${n}`,
    outputs: [
      {
        name: "DeepSeek",
        text: `Retained real answer ${n}`,
        source: liveSource("deepseek", "PLAYGROUND"),
      },
    ],
  }));
  await page.route("**/api/demo/snapshot", (r) => r.fulfill({ json: snapshot }));
  await page.route("**/api/playground/sessions", (r) => r.fulfill({ json: {} }));
  await page.goto(
    "/en/app/playground?promptId=prm_writing_course_01&versionId=ver_writing_course_03",
  );
  await page
    .getByLabel("Run history for this version", { exact: true })
    .selectOption("pls_visible_2");
  await page.getByText("Simulation · no model call", { exact: true }).click();
  await page.getByRole("button", { name: "Run simulated comparison", exact: true }).click();
  await expect(page.getByText("Retained real answer 2", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Retained real answer 2", { exact: true })).toBeVisible();
});

test("Chinese result and recovery controls fit phone, landscape and desktop", async ({
  page,
}, testInfo) => {
  const snapshot = createInitialState();
  await page.route("**/api/demo/snapshot", (r) => r.fulfill({ json: snapshot }));
  await page.route("**/api/ai/playground", (r) =>
    r.fulfill({
      status: 201,
      json: { ...resultFor(r.request().postDataJSON()), content: "真实回答版式样本。".repeat(50) },
    }),
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/zh-CN/app/playground");
  await page.getByRole("button", { name: "运行 DeepSeek 真实执行", exact: true }).click();
  await expect(page.getByText("真实回答版式样本。".repeat(50), { exact: true })).toBeVisible();
  for (const viewport of [
    { width: 375, height: 812 },
    { width: 812, height: 375 },
    { width: 1440, height: 1000 },
  ]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "20px";
    });
    await page.evaluate(() => document.fonts.ready);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`playground-${viewport.width}.png`),
      fullPage: true,
    });
  }
});
