// Explicitly authorized one-call acceptance. Never invoked by normal tests.
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { chromium } from "@playwright/test";

const recoverOnlyRequested = process.argv.includes("--recover-only");
assert.ok(
  process.argv.includes("--run-paid") || recoverOnlyRequested,
  "Explicit acceptance mode required",
);
const base = "http://127.0.0.1:3000";
const key = "playground-acceptance-20261110-v1";
const title = "模型试跑闭环验收 · 2026-11-10";
const content = "请只用中文返回下面这句话，不要添加解释、标题或其他内容：模型试跑闭环验收通过。";
const dbUrl = new URL(process.env.DATABASE_URL ?? "invalid:");
assert.ok(["127.0.0.1", "localhost"].includes(dbUrl.hostname));
assert.equal(dbUrl.pathname, "/promptmaster_dev");
let cookie = "",
  owner,
  source,
  result;
let historicalHolds = [];
let recoveryOnly = false;
const db = new Client({ connectionString: dbUrl.toString() });
const outputDir = path.join(process.env.LOCALAPPDATA, "PromptMasterAI", "playground-live-20261110");
async function api(url, body, requestKey) {
  const response = await fetch(base + url, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    headers: {
      Origin: base,
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(requestKey ? { "Idempotency-Key": requestKey } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok)
    throw Error(`${value.error ?? response.status}: ${value.message ?? "Request failed"}`);
  return { value, cookie: response.headers.get("set-cookie")?.split(";")[0] };
}
async function execution() {
  return (
    await db.query(
      `SELECT id,status,provider,requested_model,output_text,provider_attempt_count,max_attempts,
    total_tokens,calculated_cost_usd,quota_reservation_status,reconciliation_status,prompt_id,prompt_version_id
    FROM model_executions WHERE owner_user_id=$1 AND purpose='PLAYGROUND' AND playground_request_key=$2`,
      [owner, key],
    )
  ).rows;
}
let browser;
try {
  await db.connect();
  // A PTY keeps stdin open; raw mode prevents credentials from being echoed.
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  console.log("AWAIT_HIDDEN_ACCOUNT_CREDENTIALS");
  const input = createInterface({ input: process.stdin });
  let credentials;
  try {
    credentials = JSON.parse(
      await new Promise((resolve, reject) => {
        input.once("line", resolve);
        input.once("close", () =>
          reject(Error("Credential input closed before authentication; no dispatch")),
        );
      }),
    );
  } finally {
    input.close();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  }
  assert.equal(credentials.email, "1540744366@qq.com");
  const login = await api("/api/auth/login", credentials);
  credentials.password = "";
  cookie = login.cookie;
  assert.ok(cookie?.startsWith("pm_session="));
  owner = login.value.user.id;
  assert.equal(login.value.user.role, "USER");
  historicalHolds = (
    await db.query(
      `SELECT id,status,provider,completed_at,estimated_cost_usd,reconciliation_status FROM model_executions
       WHERE owner_user_id=$1 AND quota_reservation_status='HELD' ORDER BY id`,
      [owner],
    )
  ).rows;
  const existing = await execution();
  assert.ok(existing.length <= 1);
  if (existing.length) {
    recoveryOnly = true;
    // Rerunning this acceptance is reconciliation only, never another paid attempt.
    assert.equal(
      existing[0].status,
      "SUCCEEDED",
      "Prior attempt unresolved: inspect manually, no redispatch",
    );
    const recovered = (await api(`/api/ai/playground?requestKey=${key}`)).value;
    assert.equal(recovered.status, "SUCCEEDED");
    result = recovered.result;
    source = { promptId: result.promptId, versionId: result.versionId };
  } else {
    assert.ok(
      !recoverOnlyRequested,
      "No saved acceptance exists; recovery-only mode cannot dispatch",
    );
    const quota = (await api("/api/ai/quota")).value;
    assert.ok(quota.remainingTokens >= 4096, "Insufficient token envelope: no paid dispatch");
    assert.ok(quota.remainingCostUsd >= 0.01, "Insufficient local USD envelope: no paid dispatch");
    assert.ok(quota.periodRemainingTokens >= 4096, "Insufficient period token envelope");
    assert.ok(quota.periodRemainingCostUsd >= 0.01, "Insufficient period local USD envelope");
    assert.ok(quota.platform.dailyLimitUsd - quota.platform.dailyUsedUsd >= 0.01);
    assert.ok(quota.platform.periodLimitUsd - quota.platform.periodUsedUsd >= 0.01);
    const unknown = await db.query(
      `SELECT count(*)::int n FROM model_executions WHERE owner_user_id=$1 AND
      (status='PENDING' OR quota_reservation_status='RESERVED')`,
      [owner],
    );
    assert.equal(unknown.rows[0].n, 0, "Existing active account execution: no paid dispatch");
    // Old terminal timeouts remain fully reserved in the period/platform budget.
    // They are not active executions and must never be cleared for this new test.
    for (const held of historicalHolds) {
      assert.equal(held.status, "FAILED");
      assert.ok(
        held.completed_at &&
          Date.parse(held.completed_at) < Date.parse(`${quota.usageDay}T00:00:00Z`),
        "A current-day unknown charge needs review before dispatch",
      );
    }
    const snapshot = (await api("/api/demo/snapshot")).value;
    const existingPrompt = snapshot.prompts.find((p) => p.title === title);
    source = existingPrompt
      ? { promptId: existingPrompt.id, versionId: existingPrompt.currentVersionId }
      : (await api("/api/prompts", { title, content, taskType: "General", manualDraft: true }, key))
          .value;
    const savedInput = await db.query(
      "SELECT v.content FROM prompt_versions v JOIN prompts p ON p.id=v.prompt_id AND p.owner_user_id=v.owner_user_id WHERE p.owner_user_id=$1 AND p.id=$2 AND v.id=$3",
      [owner, source.promptId, source.versionId],
    );
    assert.equal(
      savedInput.rows[0]?.content,
      content,
      "Acceptance source changed: no paid dispatch",
    );
    const inputBody = {
      ...source,
      locale: "zh-CN",
      modelKey: "deepseek-direct",
      strength: "off",
      maxOutputTokens: 128,
      requestKey: key,
    };
    console.log(
      JSON.stringify({
        stage: "PAID_DISPATCH",
        model: inputBody.modelKey,
        maxOutputTokens: 128,
        retries: 0,
        localBudgetUsd: 0.01,
        tokenEnvelope: 4096,
      }),
    );
    result = (await api("/api/ai/playground", inputBody)).value;
  }
  assert.equal(result.purpose, "PLAYGROUND");
  assert.equal(result.provider, "deepseek");
  assert.equal(result.requestedModel, "deepseek-flash");
  assert.equal(result.versionId, source.versionId);
  assert.ok(result.content.trim());
  assert.ok(result.usage.totalTokens > 0 && result.usage.totalTokens <= 4096);
  assert.ok(result.usage.completionTokens <= 128);
  const before = await execution();
  assert.equal(before.length, 1);
  assert.equal(before[0].provider_attempt_count, 1);
  assert.equal(before[0].max_attempts, 1);
  assert.ok(Number(before[0].calculated_cost_usd) <= 0.01);
  const recovered = (await api(`/api/ai/playground?requestKey=${key}`)).value;
  assert.equal(recovered.status, "SUCCEEDED");
  const replay = (
    await api("/api/ai/playground", {
      ...source,
      locale: "zh-CN",
      modelKey: "deepseek-direct",
      strength: "off",
      maxOutputTokens: 128,
      requestKey: key,
    })
  ).value;
  assert.deepEqual(replay, result);
  assert.deepEqual(recovered.result, result);
  assert.deepEqual(await execution(), before);
  if (historicalHolds.length) {
    assert.deepEqual(
      (
        await db.query(
          `SELECT id,status,provider,completed_at,estimated_cost_usd,reconciliation_status FROM model_executions
       WHERE owner_user_id=$1 AND quota_reservation_status='HELD' ORDER BY id`,
          [owner],
        )
      ).rows,
      historicalHolds,
    );
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([
    {
      name: "pm_session",
      value: cookie.slice("pm_session=".length),
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  const page = await context.newPage();
  // Browser acceptance reads real stored output; all model POSTs are forbidden here.
  let forbiddenPosts = 0;
  await page.route("**/api/ai/**", (route) => {
    if (route.request().method() === "POST") {
      forbiddenPosts++;
      return route.abort();
    }
    return route.continue();
  });
  await page.goto(`${base}/zh-CN/app/playground`);
  await page.getByLabel("已保存的 Prompt", { exact: true }).selectOption(source.promptId);
  await page.getByLabel("已保存版本", { exact: true }).selectOption(source.versionId);
  await page.getByText(result.content, { exact: true }).waitFor();
  await page.reload();
  await page.getByText(result.content, { exact: true }).waitFor();
  await page.getByRole("link", { name: "查看执行报告", exact: true }).click();
  await page.waitForURL((url) => url.pathname.endsWith("/app/execution-evaluation"));
  assert.equal(new URL(page.url()).searchParams.get("versionId"), source.versionId);
  await page.goto(`${base}/zh-CN/app/playground`);
  await page.getByText(result.content, { exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await mkdir(outputDir, { recursive: true });
  await page.screenshot({
    path: path.join(outputDir, "live-playground-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({
    path: path.join(outputDir, "live-playground-mobile.png"),
    fullPage: true,
  });
  assert.equal(forbiddenPosts, 0);
  const evidence = {
    status: "PASS",
    mode: recoveryOnly ? "RECOVERY_ONLY" : "ONE_PAID_ACCEPTANCE",
    authorizedDate: "2026-11-10",
    requestKey: key,
    ...source,
    result,
    ledger: before[0],
    sameKeyReplay: "UNCHANGED_EXECUTION_AND_USAGE",
    browserReload: "REAL_SAVED_OUTPUT_RESTORED",
    browserPaidPosts: forbiddenPosts,
    localEstimateUsd: Number(before[0].calculated_cost_usd),
    providerBilledAmount: "NOT_RECONCILED",
    historicalHolds: historicalHolds.map(({ id, estimated_cost_usd }) => ({
      id,
      estimatedCostUsd: estimated_cost_usd,
    })),
    retention: "RETAINED_FOR_AUDIT",
  };
  // Never overwrite the first paid acceptance evidence during reconciliation.
  const evidenceName = recoveryOnly
    ? `acceptance-recovery-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
    : "acceptance.json";
  await writeFile(path.join(outputDir, evidenceName), JSON.stringify(evidence, null, 2), {
    flag: "wx",
  });
  console.log(JSON.stringify(evidence, null, 2));
  console.log(`EVIDENCE_DIRECTORY ${outputDir}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Acceptance failed");
  console.log(
    JSON.stringify({
      status: "FAILED_OR_UNCONFIRMED",
      requestKey: key,
      ...source,
      retention: "PRESERVED_NO_AUTOMATIC_RETRY",
    }),
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (cookie) await api("/api/auth/logout", {}).catch(() => {});
  await db.end();
}
