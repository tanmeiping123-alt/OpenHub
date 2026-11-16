// One approved, side-effectful experiment. Never add to CI or auto-rerun.
// Credentials arrive only through non-echoing stdin. Journals are the existing
// workflow keys, immutable versions, executions and quota ledger, never secrets.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import ts from "typescript";
import pg from "pg";
import {
  experiment as exp,
  roundUp,
  reserveFor,
  guardBudget,
  guardCompletion,
  serializePersistedContext,
} from "./skill-effect-experiment-policy.mjs";

assert.ok(
  process.argv.includes("--approved-run"),
  "Explicit approved-run flag is required; this incurs charges.",
);
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.dirname(frontend);
const base = "http://127.0.0.1:3000";
const manager = path.join(root, "scripts", "manage-server.ps1");
const originalEnv = { ...process.env };
const envHash = () =>
  createHash("sha256")
    .update(readFileSync(path.join(frontend, ".env.local")))
    .digest("hex");
const hashBefore = envHash();
const sha = (text) => createHash("sha256").update(text).digest("hex");
const databaseUrl = new URL(process.env.DATABASE_URL ?? "invalid:");
assert.ok(["127.0.0.1", "localhost"].includes(databaseUrl.hostname));
assert.equal(databaseUrl.pathname, "/promptmaster_dev");
assert.equal(databaseUrl.port, "55432");
assert.equal(process.env.DEEPSEEK_MODEL, "deepseek-flash");
assert.equal(process.env.DEEPSEEK_PRODUCT_VERSION, "DeepSeek-V4.1-Flash-1017");
assert.equal(new URL(process.env.DEEPSEEK_BASE_URL).origin, "https://api.deepseek.com");
let db;
const connect = async () => {
  db = new pg.Client({ connectionString: databaseUrl.toString(), connectionTimeoutMillis: 5000 });
  await db.connect();
};
const disconnect = async () => {
  await db?.end();
  db = undefined;
};
const emit = (phase, value = {}) =>
  console.log(JSON.stringify({ phase, experimentId: exp.id, ...value }));
let lifecycleChanged = false;
let cookie;
let owner;
let pricing;
let day;
let initialExecutionCount;
let initialUsage;
const results = [];
const keys = ["g0", "g1", "o0", "o1"].map((label) => `${exp.id}-${label}`);
// Narrow reconciliation of the one known successful dispatch. Never retry it,
// adopt a failed/unknown call, create replacement plans, or reset its budget.
const reconcileFirst = process.argv.includes("--reconcile-first-success");
const retainedGroups = [
  {
    planId: "swp_7868f102-f88f-44e2-b988-020faf76da22",
    baseline: {
      promptId: "prm_44133234-8fea-40b8-8d6f-8a59a212bac0",
      versionId: "ver_2c6e2aae-9f77-40fa-862e-eea60efab8cd",
    },
  },
  {
    planId: "swp_70f8de25-03a8-406e-9f7d-8a076c162c4f",
    baseline: {
      promptId: "prm_3bf188d3-0a1b-4515-b63b-21938154f387",
      versionId: "ver_9258f6ce-d62a-4aa3-bf32-8758d33129ed",
    },
  },
];
if (process.stdin.isTTY) process.stdin.setRawMode(true);
const lines = createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator]();
async function inputLine(expected) {
  const item = await lines.next();
  assert.ok(!item.done, "INPUT_CLOSED_STOP");
  if (expected !== undefined) assert.equal(item.value, expected, "OPERATOR_STOP");
  return item.value;
}
async function api(route, body, expected = 200, key) {
  assert.ok(
    /^\/api\/(?:auth\/(?:login|logout)|ai\/quota|skills\/(?:workflow(?:\?requestKey=[a-zA-Z0-9._-]+)?|library\?versionId=skv_[a-f0-9-]+|provenance\?versionId=ver_[a-f0-9-]+)|prompts(?:\/prm_[a-f0-9-]+\/versions)?)$/.test(
      route,
    ),
    "UNAPPROVED_ENDPOINT",
  );
  const response = await fetch(base + route, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Origin: base,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(45000),
  });
  const value = await response.json();
  assert.equal(response.status, expected, `${route}: ${value.error ?? response.status}`);
  return { value, session: response.headers.get("set-cookie")?.split(";")[0] };
}
async function lifecycle(action, env, openBrowser = false) {
  emit("LIFECYCLE", {
    action,
    limits: env === originalEnv ? "RESTORE_ORIGINAL" : "EXPERIMENT_TEMPORARY",
  });
  const output = await new Promise((resolve, reject) => {
    // PostgreSQL may retain inherited pipe handles after PowerShell exits.
    // Await the manager's exit, not the eventual closure of descendant pipes.
    let stdout = "";
    const child = execFile(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        manager,
        "-Action",
        action,
        ...(openBrowser ? [] : ["-NoBrowser"]),
      ],
      { cwd: root, env, encoding: "utf8", timeout: 65000, windowsHide: true },
    );
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", () => reject(Error("LOCAL_SERVER_LIFECYCLE_FAILED")));
    child.once("exit", (code) => {
      child.stdout.destroy();
      child.stderr.destroy();
      if (code !== 0) reject(Error("LOCAL_SERVER_LIFECYCLE_FAILED"));
      else resolve(stdout);
    });
  });
  assert.ok(output.includes(action === "Stop" ? "STOPPED:" : "READY:"));
  emit("LIFECYCLE_READY", { action });
}
// Compile only the named trusted repository function and inject its narrow
// dependencies. This is offline and reuses exact app serialization, not Skill code.
function functionFromSource(relative, name, dependencies = {}) {
  const source = readFileSync(path.join(frontend, relative), "utf8");
  const ast = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(
    (part) => ts.isFunctionDeclaration(part) && part.name?.text === name,
  );
  assert.ok(declaration, `SOURCE_FUNCTION_NOT_FOUND:${name}`);
  const js = ts.transpileModule(declaration.getText(ast).replace(/^export\s+/, ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(dependencies), `${js}\nreturn ${name};`)(
    ...Object.values(dependencies),
  );
}
const prompts = functionFromSource("src/lib/server/model/deepseek-provider.ts", "deepSeekPrompts");
const inputHash = functionFromSource("src/lib/server/model/model-service.ts", "inputHash", {
  createHash,
});
async function usage() {
  return (
    await db.query(
      `SELECT to_char(timezone('UTC',now()),'YYYY-MM-DD') AS "day",
    COALESCE((SELECT settled_tokens FROM model_quota_usage_daily WHERE owner_user_id=$1 AND usage_day=(timezone('UTC',now()))::date),0)::integer tokens,
    COALESCE((SELECT settled_cost_usd FROM model_quota_usage_daily WHERE owner_user_id=$1 AND usage_day=(timezone('UTC',now()))::date),0)::text usd,
    COALESCE((SELECT reserved_tokens FROM model_quota_usage_daily WHERE owner_user_id=$1 AND usage_day=(timezone('UTC',now()))::date),0)::integer held,
    COALESCE((SELECT reserved_cost_usd FROM model_quota_usage_daily WHERE owner_user_id=$1 AND usage_day=(timezone('UTC',now()))::date),0)::text heldUsd`,
      [owner],
    )
  ).rows[0];
}
async function executionFor(key) {
  return (
    await db.query(
      `SELECT m.id,m.owner_user_id,m.purpose,m.status,m.input_sha256,m.provider,m.requested_model,m.resolved_model,m.product_version,
    m.provider_request_id,m.system_fingerprint,m.prompt_id,m.prompt_version_id,m.prompt_tokens,m.completion_tokens,m.total_tokens,
    m.prompt_cache_hit_tokens,m.prompt_cache_miss_tokens,m.finish_reason,m.latency_ms,m.pricing_snapshot_id,m.calculated_cost_usd,
    m.estimated_cost_usd,m.reserved_total_tokens,m.per_attempt_tokens,m.per_attempt_cost_usd,m.max_attempts,m.provider_attempt_count,
    m.quota_reservation_status,m.reconciliation_status,m.error_code,m.output_text,m.created_at,m.completed_at
    FROM skill_workflow_runs r JOIN model_executions m ON m.id=r.execution_id AND m.owner_user_id=r.owner_user_id
    WHERE r.owner_user_id=$1 AND r.request_key=$2`,
      [owner, key],
    )
  ).rows[0];
}
try {
  await connect();
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::integer n FROM skill_workflow_runs WHERE request_key=ANY($1::text[])",
        [keys],
      )
    ).rows[0].n,
    reconcileFirst ? 1 : 0,
    "EXPERIMENT_ALREADY_STARTED_RECONCILE_ONLY",
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::integer n FROM model_executions WHERE status='PENDING' OR quota_reservation_status IN('RESERVED','HELD')",
      )
    ).rows[0].n,
    0,
    "EXISTING_UNRESOLVED_EXECUTION",
  );
  emit("AWAIT_HIDDEN_USER_CREDENTIALS");
  let credentials = JSON.parse(await inputLine());
  assert.equal(credentials.email, exp.ownerEmail);
  const login = await api("/api/auth/login", credentials);
  credentials.password = "";
  credentials = null;
  cookie = login.session;
  owner = login.value.user.id;
  assert.equal(login.value.user.role, "USER");
  assert.ok(cookie?.startsWith("pm_session="));
  initialUsage = await usage();
  day = initialUsage.day;
  assert.equal(initialUsage.held, 0);
  let retainedExecution;
  if (reconcileFirst) {
    retainedExecution = await executionFor(keys[0]);
    assert.equal(retainedExecution?.id, "mex_fc49f6d9-56b7-4c5a-8d7d-d15d1094faa7");
    guardCompletion(retainedExecution);
    assert.equal(day, "2026-11-05");
    assert.equal(initialUsage.tokens, 5915, "CONCURRENT_ACCOUNT_ACTIVITY_STOP");
    assert.equal(initialUsage.usd, "0.00438540", "CONCURRENT_ACCOUNT_ACTIVITY_STOP");
    initialUsage = { ...initialUsage, tokens: 4039, usd: "0.00309270" };
    emit("KNOWN_SUCCESS_RECONCILE_NO_REDISPATCH", {
      key: keys[0],
      executionId: retainedExecution.id,
    });
  }
  initialExecutionCount = (
    await db.query("SELECT count(*)::integer n FROM model_executions WHERE owner_user_id=$1", [
      owner,
    ])
  ).rows[0].n;
  if (reconcileFirst) initialExecutionCount -= 1;
  const policy = (
    await db.query("SELECT * FROM model_quota_policies WHERE owner_user_id=$1", [owner])
  ).rows[0];
  assert.equal(policy.enabled, true);
  const policyHash = sha(JSON.stringify(policy));
  pricing = (
    await db.query(`SELECT * FROM model_pricing_snapshots WHERE provider='deepseek' AND requested_model='deepseek-flash' AND product_version='DeepSeek-V4.1-Flash-1017'
    AND pricing_window='PEAK' AND effective_at<=now() AND valid_until>now() ORDER BY effective_at DESC,captured_at DESC,id DESC LIMIT 1`)
  ).rows[0];
  assert.ok(pricing, "ACTIVE_PRICING_SNAPSHOT_REQUIRED");
  const tokenCeiling = Math.min(
    Number(originalEnv.PROMPTMASTER_MODEL_DAILY_TOKEN_LIMIT || 100000),
    policy.daily_token_limit,
    initialUsage.tokens + exp.maxEnvelopeTokens,
  );
  const usdCeiling = Math.min(
    Number(originalEnv.PROMPTMASTER_MODEL_DAILY_COST_LIMIT_USD || 0.12),
    Number(policy.daily_cost_limit_usd),
    roundUp(Number(initialUsage.usd) + exp.maxEstimatedUsd),
  );
  const limitedEnv = {
    ...originalEnv,
    PROMPTMASTER_MODEL_MAX_RETRIES: "0",
    PROMPTMASTER_MODEL_MAX_OUTPUT_TOKENS: "1200",
    PROMPTMASTER_MODEL_PRICING_WINDOW: "PEAK",
    PROMPTMASTER_MODEL_DAILY_TOKEN_LIMIT: String(tokenCeiling),
    PROMPTMASTER_MODEL_DAILY_COST_LIMIT_USD: String(usdCeiling),
  };
  emit("LIMITS_PREPARED", {
    day,
    owner,
    initialUsage,
    temporaryDailyTokens: tokenCeiling,
    temporaryDailyUsd: usdCeiling,
    pricingId: pricing.id,
  });
  await disconnect();
  lifecycleChanged = true;
  await lifecycle("Stop", originalEnv);
  await lifecycle("Start", limitedEnv);
  await connect();
  const quota = (await api("/api/ai/quota")).value;
  assert.equal(quota.dailyTokenLimit, tokenCeiling);
  assert.equal(quota.dailyCostLimitUsd, usdCeiling);
  assert.equal(quota.pricingWindow, "PEAK");
  assert.equal(quota.usageDay, day);
  const skill = (await api(`/api/skills/library?versionId=${exp.skillVersionId}`)).value;
  assert.equal(skill.accessKind, "LIBRARY");
  assert.equal(skill.source.commitSha, exp.commit);
  assert.equal(skill.manifestSha256, exp.manifest);
  const groups = [];
  for (const withSkill of [false, true]) {
    const retained = retainedGroups[withSkill ? 1 : 0];
    const created = reconcileFirst
      ? { id: retained.planId }
      : (
          await api("/api/skills/workflow", {
            action: "plan",
            goal: exp.goal,
            taskType: "Coding",
            locale: "zh-CN",
            matchingMode: "MANUAL",
            selectedVersionIds: withSkill ? [exp.skillVersionId] : [],
            manualOverride: true,
          })
        ).value;
    // Model Service reloads JSONB from PostgreSQL, whose object key order differs
    // from the create-plan HTTP response. Reconstruct from that same persisted
    // representation; semantic deep equality alone does not prove input bytes.
    const planRow = (
      await db.query("SELECT * FROM skill_workflow_plans WHERE id=$1 AND owner_user_id=$2", [
        created.id,
        owner,
      ])
    ).rows[0];
    assert.ok(planRow);
    assert.equal(planRow.goal, exp.goal);
    assert.equal(planRow.task_type, "Coding");
    assert.equal(planRow.locale, "zh-CN");
    assert.equal(planRow.matching_mode, "MANUAL");
    const plan = { id: planRow.id, analysis: planRow.analysis, selections: planRow.selections };
    if (!reconcileFirst) {
      assert.deepEqual(plan.analysis, created.analysis);
      assert.deepEqual(plan.selections, created.selections);
    }
    assert.equal(plan.selections.length, withSkill ? 1 : 0);
    let loaded = [];
    if (withSkill) {
      const load = functionFromSource(
        "src/lib/server/skills/skill-context.ts",
        "loadSkillContext",
        {
          path,
          WORKFLOW_LIMITS: { contextBytes: 49152 },
          AccountError: Error,
          skillContent: async () => skill,
        },
      );
      const context = await load(null, null, exp.skillVersionId, plan.selections[0].responsibility);
      assert.deepEqual(context.selection, plan.selections[0]);
      loaded = [context.text];
    }
    const contextText = serializePersistedContext(planRow, loaded);
    const baseline = reconcileFirst
      ? retained.baseline
      : (
          await api(
            "/api/prompts",
            {
              title: `软删除恢复固定基线 · ${exp.id} · ${withSkill ? "B" : "A"}`,
              content: exp.baseline,
              taskType: "Coding",
              description:
                "Approved experiment fixed manual baseline; identical content across A/B.",
              manualDraft: true,
            },
            201,
            `${exp.id}-baseline-${withSkill ? "b" : "a"}`,
          )
        ).value;
    groups.push({ withSkill, plan, baseline, contextText });
  }
  const baselineRows = (
    await db.query(
      "SELECT id,content,source FROM prompt_versions WHERE id=ANY($1::text[]) ORDER BY id",
      [groups.map((g) => g.baseline.versionId)],
    )
  ).rows;
  assert.equal(baselineRows.length, 2);
  for (const row of baselineRows) {
    assert.equal(row.content, exp.baseline);
    assert.equal(row.source, "MANUAL_DRAFT");
  }
  const cases = keys.map((key, i) => {
    const group = groups[i % 2];
    const purpose = i < 2 ? "PROMPT_GENERATION" : "OPTIMIZATION";
    const input = {
      goal: exp.goal,
      taskType: "Coding",
      locale: "zh-CN",
      skillPlanId: group.plan.id,
      skillContext: group.contextText,
      ...(purpose === "OPTIMIZATION" ? { kind: purpose, sourceContent: exp.baseline } : {}),
    };
    const envelope = reserveFor(JSON.stringify(prompts({ ...input, kind: purpose })), pricing);
    return { key, group, purpose, input, envelope, inputSha256: inputHash(input) };
  });
  const plannedTokens = cases.reduce((n, c) => n + c.envelope.tokens, 0),
    plannedUsd = roundUp(cases.reduce((n, c) => n + c.envelope.usd, 0));
  guardBudget(4, plannedTokens, plannedUsd);
  assert.ok(initialUsage.tokens + plannedTokens <= tokenCeiling);
  assert.ok(roundUp(Number(initialUsage.usd) + plannedUsd) <= usdCeiling);
  if (reconcileFirst) {
    assert.equal(
      retainedExecution.input_sha256,
      cases[0].inputSha256,
      "PERSISTED_INPUT_NOT_RECONCILED",
    );
    assert.equal(retainedExecution.per_attempt_tokens, cases[0].envelope.tokens);
    assert.equal(Number(retainedExecution.per_attempt_cost_usd), cases[0].envelope.usd);
  }
  emit(reconcileFirst ? "RECONCILED_READY_FOR_REMAINING_THREE" : "PREPARED_NO_PAID_CALLS_YET", {
    goal: exp.goal,
    baseline: exp.baseline,
    baselineSha256: sha(exp.baseline),
    groups: groups.map((g) => ({
      withSkill: g.withSkill,
      planId: g.plan.id,
      baseline: g.baseline,
      selection: g.plan.selections,
    })),
    plannedEnvelopeTokens: plannedTokens,
    plannedReservedUsd: plannedUsd,
    cases: cases.map((c) => ({
      key: c.key,
      purpose: c.purpose,
      inputSha256: c.inputSha256,
      envelope: c.envelope,
    })),
    maxRetries: 0,
    maxOutputTokens: 1200,
  });
  let committedTokens = 0,
    committedUsd = 0;
  for (const testCase of cases) {
    const existingSuccess = reconcileFirst && testCase.key === keys[0];
    let workflow;
    if (!existingSuccess) {
      emit("AWAIT_DISPATCH", { key: testCase.key, requiredInput: `DISPATCH_${testCase.key}` });
      await inputLine(`DISPATCH_${testCase.key}`);
      const current = await usage();
      assert.equal(current.day, day, "UTC_DAY_CHANGED_STOP");
      assert.equal(current.held, 0, "UNRESOLVED_USAGE_STOP");
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::integer n FROM model_executions WHERE owner_user_id=$1",
            [owner],
          )
        ).rows[0].n,
        initialExecutionCount + results.length,
        "CONCURRENT_ACCOUNT_ACTIVITY_STOP",
      );
      assert.equal(
        (await api(`/api/skills/workflow?requestKey=${testCase.key}`)).value.status,
        "NOT_FOUND",
        "DO_NOT_REDISPATCH_EXISTING_REQUEST",
      );
      committedTokens += testCase.envelope.tokens;
      committedUsd = roundUp(committedUsd + testCase.envelope.usd);
      guardBudget(results.length + 1, committedTokens, committedUsd);
      guardBudget(
        results.length + 1,
        current.tokens - initialUsage.tokens + testCase.envelope.tokens,
        roundUp(Number(current.usd) - Number(initialUsage.usd) + testCase.envelope.usd),
      );
      const body = {
        action: "run",
        planId: testCase.group.plan.id,
        purpose: testCase.purpose,
        ...(testCase.purpose === "OPTIMIZATION"
          ? {
              promptId: testCase.group.baseline.promptId,
              versionId: testCase.group.baseline.versionId,
            }
          : {}),
      };
      emit("DISPATCH_ONCE", { key: testCase.key, ordinal: results.length + 1 });
      workflow = (await api("/api/skills/workflow", body, 200, testCase.key)).value;
    } else {
      committedTokens += testCase.envelope.tokens;
      committedUsd = roundUp(committedUsd + testCase.envelope.usd);
      guardBudget(1, committedTokens, committedUsd);
      workflow = (await api(`/api/skills/workflow?requestKey=${testCase.key}`)).value;
    }
    const row = await executionFor(testCase.key);
    emit("MODEL_RECORDED", {
      key: testCase.key,
      workflowId: workflow.id,
      workflowStatus: workflow.status,
      execution: row,
    });
    assert.ok(row, "NO_EXECUTION_PROOF_STOP_RECONCILE");
    results.push({ key: testCase.key, executionId: row.id, workflowId: workflow.id });
    guardCompletion(row);
    assert.equal(row.owner_user_id, owner);
    assert.equal(row.input_sha256, testCase.inputSha256);
    assert.equal(row.provider, "deepseek");
    assert.equal(row.requested_model, "deepseek-flash");
    assert.equal(row.product_version, "DeepSeek-V4.1-Flash-1017");
    assert.equal(row.pricing_snapshot_id, pricing.id);
    assert.equal(row.per_attempt_tokens, testCase.envelope.tokens);
    assert.equal(Number(row.per_attempt_cost_usd), testCase.envelope.usd);
    assert.equal(row.resolved_model, "deepseek-flash");
    assert.ok(row.provider_request_id);
    const result = workflow.result;
    assert.equal(workflow.status, "SUCCEEDED");
    assert.equal(result.executionId, row.id);
    let saved = { promptId: result.promptId, versionId: result.versionId };
    if (testCase.purpose === "OPTIMIZATION") {
      assert.equal(result.promptId, testCase.group.baseline.promptId);
      assert.equal(result.versionId, testCase.group.baseline.versionId);
      saved = (
        await api(
          `/api/prompts/${result.promptId}/versions`,
          {
            content: result.content,
            baseVersionId: result.versionId,
            source: "SKILL_LIVE_OPTIMIZATION",
            optimizationId: result.optimizationId,
          },
          201,
        )
      ).value;
      assert.notEqual(saved.versionId, result.versionId);
      assert.equal(saved.number, 2);
    }
    const savedRow = (
      await db.query(
        "SELECT content,source,version_number,parent_version_id FROM prompt_versions WHERE id=$1 AND owner_user_id=$2",
        [saved.versionId, owner],
      )
    ).rows[0];
    assert.equal(savedRow.content, row.output_text);
    const sources = (await api(`/api/skills/provenance?versionId=${saved.versionId}`)).value
      .sources;
    assert.equal(sources.length, testCase.group.withSkill ? 1 : 0);
    if (testCase.group.withSkill) {
      assert.equal(sources[0].skillVersionId, exp.skillVersionId);
      assert.equal(sources[0].executionId, row.id);
      assert.equal(sources[0].planId, testCase.group.plan.id);
      assert.equal(sources[0].manifestSha256, exp.manifest);
      assert.deepEqual(sources[0].resources, testCase.group.plan.selections[0].resources);
    }
    results.at(-1).saved = saved;
    emit("SAVED_VERSION_VERIFIED", { key: testCase.key, saved, savedRow, sources });
  }
  assert.equal(results.length, 4);
  assert.equal(
    sha(
      JSON.stringify(
        (await db.query("SELECT * FROM model_quota_policies WHERE owner_user_id=$1", [owner]))
          .rows[0],
      ),
    ),
    policyHash,
    "LONG_TERM_POLICY_CHANGED",
  );
  const finalUsage = await usage();
  guardBudget(
    4,
    finalUsage.tokens - initialUsage.tokens,
    roundUp(Number(finalUsage.usd) - Number(initialUsage.usd)),
  );
  assert.equal(finalUsage.held, 0);
  assert.equal(envHash(), hashBefore);
  emit("FOUR_CALL_ACCEPTANCE_PASS", {
    results,
    initialUsage,
    finalUsage,
    committedTokens,
    committedUsd,
    baselineSha256: sha(exp.baseline),
    envUnchanged: true,
    longTermPolicyUnchanged: true,
  });
} catch (error) {
  emit("STOP_NO_RETRY_OR_TOP_UP", {
    errorType: error.name,
    errorCode: /^[A-Z0-9_]+$/.test(error.code ?? "") ? error.code : undefined,
    location: error.stack
      ?.split("\n")
      .slice(1, 4)
      .map((line) => line.trim()),
    reason:
      error instanceof assert.AssertionError
        ? error.message
        : /^[A-Z_]+$/.test(error.message ?? "")
          ? error.message
          : "EXPERIMENT_INTERRUPTED_RECONCILE_EXISTING_KEYS",
    retainedKeys: keys,
    results,
  });
  process.exitCode = 1;
} finally {
  if (cookie) await api("/api/auth/logout", {}).catch(() => {});
  await disconnect().catch(() => {});
  if (lifecycleChanged) {
    try {
      await lifecycle("Stop", originalEnv);
      await lifecycle("Start", originalEnv, true);
      emit("NORMAL_SERVICE_RESTORED");
    } catch {
      emit("RESTORE_FAILED_MANUAL_ATTENTION_REQUIRED");
      process.exitCode = 1;
    }
  }
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  await lines.return?.();
}
