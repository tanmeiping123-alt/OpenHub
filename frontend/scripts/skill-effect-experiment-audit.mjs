// Repeatable read-only verification of the retained four paid calls. No HTTP,
// supplier requests, secrets, or output bodies are emitted.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import {
  experiment as exp,
  guardBudget,
  guardCompletion,
} from "./skill-effect-experiment-policy.mjs";

const url = new URL(process.env.DATABASE_URL ?? "invalid:");
assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
assert.equal(url.port, "55432");
assert.equal(url.pathname, "/promptmaster_dev");
const db = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
const sha = (value) => createHash("sha256").update(value).digest("hex");
await db.connect();
try {
  await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const rows = (
    await db.query(
      `SELECT r.request_key,r.id AS workflow_id,r.plan_id,r.result,r.status AS workflow_status,
    m.*,p.selections FROM skill_workflow_runs r JOIN model_executions m ON m.id=r.execution_id AND m.owner_user_id=r.owner_user_id
    JOIN skill_workflow_plans p ON p.id=r.plan_id AND p.owner_user_id=r.owner_user_id
    JOIN regular_users u ON u.user_id=r.owner_user_id WHERE u.email=$1 AND r.request_key=ANY($2::text[]) ORDER BY r.request_key`,
      [exp.ownerEmail, ["g0", "g1", "o0", "o1"].map((label) => `${exp.id}-${label}`)],
    )
  ).rows;
  assert.equal(rows.length, 4);
  let tokens = 0,
    usdUnits = 0,
    envelope = 0,
    reserveUnits = 0;
  const proofs = [];
  for (const row of rows) {
    guardCompletion(row);
    assert.equal(row.workflow_status, "SUCCEEDED");
    assert.equal(row.provider, "deepseek");
    assert.equal(row.requested_model, "deepseek-flash");
    assert.equal(row.resolved_model, "deepseek-flash");
    assert.equal(row.product_version, "DeepSeek-V4.1-Flash-1017");
    assert.equal(row.pricing_snapshot_id, "mps_deepseek_flash_1017_peak_20261105");
    assert.ok(row.provider_request_id);
    assert.equal(row.result.content, row.output_text);
    assert.equal(row.reserved_total_tokens, 0);
    const label = row.request_key.slice(-2),
      withSkill = label.endsWith("1");
    assert.equal(row.selections.length, withSkill ? 1 : 0);
    if (withSkill) {
      assert.equal(row.selections[0].versionId, exp.skillVersionId);
      assert.equal(row.selections[0].manifestSha256, exp.manifest);
    }
    let savedId = row.prompt_version_id;
    if (label.startsWith("o")) {
      assert.equal(row.purpose, "OPTIMIZATION");
      const baseline = (
        await db.query(
          "SELECT content,source,version_number FROM prompt_versions WHERE id=$1 AND owner_user_id=$2",
          [row.prompt_version_id, row.owner_user_id],
        )
      ).rows[0];
      assert.equal(baseline.content, exp.baseline);
      assert.equal(baseline.source, "MANUAL_DRAFT");
      assert.equal(baseline.version_number, 1);
      const applied = (
        await db.query(
          "SELECT a.prompt_version_id FROM skill_optimization_applications a JOIN optimization_records o ON o.id=a.optimization_id AND o.owner_user_id=a.owner_user_id WHERE o.model_execution_id=$1 AND a.owner_user_id=$2",
          [row.id, row.owner_user_id],
        )
      ).rows;
      assert.equal(applied.length, 1);
      savedId = applied[0].prompt_version_id;
    } else assert.equal(row.purpose, "PROMPT_GENERATION");
    const saved = (
      await db.query(
        "SELECT id,prompt_id,source,version_number,parent_version_id,content FROM prompt_versions WHERE id=$1 AND owner_user_id=$2",
        [savedId, row.owner_user_id],
      )
    ).rows[0];
    assert.equal(saved.prompt_id, row.prompt_id);
    assert.equal(saved.content, row.output_text);
    assert.equal(saved.version_number, label.startsWith("o") ? 2 : 1);
    assert.equal(
      saved.source,
      label.startsWith("o") ? "SKILL_LIVE_OPTIMIZATION" : "DEEPSEEK_LIVE_GENERATION",
    );
    if (label.startsWith("o")) assert.equal(saved.parent_version_id, row.prompt_version_id);
    const sources = (
      await db.query(
        "SELECT skill_version_id,manifest_sha256,plan_id,model_execution_id,resources,evidence_kind FROM prompt_skill_sources WHERE prompt_version_id=$1 AND owner_user_id=$2",
        [savedId, row.owner_user_id],
      )
    ).rows;
    assert.equal(sources.length, withSkill ? 1 : 0);
    if (withSkill) {
      const s = sources[0];
      assert.equal(s.skill_version_id, exp.skillVersionId);
      assert.equal(s.manifest_sha256, exp.manifest);
      assert.equal(s.plan_id, row.plan_id);
      assert.equal(s.model_execution_id, row.id);
      assert.equal(s.evidence_kind, "MODEL_CONTEXT");
      assert.deepEqual(s.resources, row.selections[0].resources);
    }
    tokens += row.total_tokens;
    usdUnits += Math.round(Number(row.calculated_cost_usd) * 1e8);
    envelope += row.per_attempt_tokens;
    reserveUnits += Math.round(Number(row.per_attempt_cost_usd) * 1e8);
    proofs.push({
      label,
      workflowId: row.workflow_id,
      executionId: row.id,
      planId: row.plan_id,
      promptId: row.prompt_id,
      sourceVersionId: row.prompt_version_id,
      savedVersionId: savedId,
      outputSha256: sha(row.output_text),
      inputSha256: row.input_sha256,
      providerRequestId: row.provider_request_id,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      totalTokens: row.total_tokens,
      cacheHitTokens: row.prompt_cache_hit_tokens,
      cacheMissTokens: row.prompt_cache_miss_tokens,
      finishReason: row.finish_reason,
      attempts: row.provider_attempt_count,
      localEstimatedUsd: row.calculated_cost_usd,
      sources,
    });
  }
  guardBudget(rows.length, tokens, usdUnits / 1e8);
  guardBudget(rows.length, envelope, reserveUnits / 1e8);
  console.log(
    JSON.stringify(
      {
        readOnly: true,
        experimentId: exp.id,
        status: "PASS",
        costBasis: "LOCAL_ESTIMATE_NOT_PROVIDER_INVOICE",
        baselineSha256: sha(exp.baseline),
        requests: rows.length,
        totalTokens: tokens,
        localEstimatedUsd: (usdUnits / 1e8).toFixed(8),
        envelopeTokens: envelope,
        reservedEnvelopeUsd: (reserveUnits / 1e8).toFixed(8),
        proofs,
      },
      null,
      2,
    ),
  );
} finally {
  await db.query("ROLLBACK").catch(() => {});
  await db.end();
}
