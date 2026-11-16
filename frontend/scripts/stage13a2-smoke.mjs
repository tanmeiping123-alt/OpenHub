import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { liveSmokeAuth } from "./live-smoke-auth.mjs";

const baseUrl = process.env.PROMPTMASTER_MODEL_SMOKE_BASE_URL ?? "http://127.0.0.1:3000";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const input = {
  promptId: process.env.PROMPTMASTER_MODEL_SMOKE_PROMPT_ID,
  versionId: process.env.PROMPTMASTER_MODEL_SMOKE_VERSION_ID,
  locale: "en",
};
const cases = [
  { purpose: "OPTIMIZATION", path: "/api/ai/optimize" },
  { purpose: "PLAYGROUND", path: "/api/ai/playground" },
  { purpose: "EVALUATION_ADVICE", path: "/api/ai/evaluation-advice" },
];
const results = [];
const executionIds = [];

try {
  if (!input.promptId || !input.versionId)
    throw new Error(
      "Set PROMPTMASTER_MODEL_SMOKE_PROMPT_ID and PROMPTMASTER_MODEL_SMOKE_VERSION_ID to this account's source records; legacy demo records are not reused.",
    );
  const headers = await liveSmokeAuth(baseUrl);
  for (const testCase of cases) {
    const response = await fetch(`${baseUrl}${testCase.path}`, {
      method: "POST",
      headers,
      redirect: "error",
      body: JSON.stringify({
        ...input,
        ...(testCase.purpose === "PLAYGROUND" ? { requestKey: randomUUID() } : {}),
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(`${testCase.purpose} smoke failed: ${payload.error ?? response.status}`);
    }
    assert.equal(payload.executionMode, "LIVE");
    assert.equal(payload.purpose, testCase.purpose);
    assert.equal(payload.promptId, input.promptId);
    assert.equal(payload.versionId, input.versionId);
    assert.equal(payload.provider, "deepseek");
    assert.ok(payload.content.length > 0);
    assert.ok(payload.usage.totalTokens > 0);
    executionIds.push(payload.executionId);
    results.push({
      purpose: payload.purpose,
      requestedModel: payload.requestedModel,
      resolvedModel: payload.resolvedModel,
      usage: payload.usage,
      latencyMs: payload.latencyMs,
    });
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const executions = await client.query(
      `SELECT id, purpose, status, prompt_id, prompt_version_id, output_text, total_tokens
       FROM model_executions WHERE id = ANY($1::text[]) ORDER BY purpose`,
      [executionIds],
    );
    assert.equal(executions.rowCount, 3);
    for (const row of executions.rows) {
      assert.equal(row.status, "SUCCEEDED");
      assert.equal(row.prompt_id, input.promptId);
      assert.equal(row.prompt_version_id, input.versionId);
      assert.ok(row.output_text.length > 0);
      assert.ok(row.total_tokens > 0);
    }
    const optimization = await client.query(
      `SELECT source FROM optimization_records WHERE model_execution_id = $1`,
      [executionIds[0]],
    );
    assert.equal(optimization.rows[0]?.source, "DEEPSEEK_LIVE_OPTIMIZATION");
    const playground = await client.query(
      `SELECT ps.source, mcr.source AS output_source
       FROM playground_sessions ps
       JOIN model_comparison_results mcr ON mcr.session_id = ps.id
       WHERE ps.model_execution_id = $1`,
      [executionIds[1]],
    );
    assert.equal(playground.rows[0]?.source, "DEEPSEEK_LIVE_PLAYGROUND");
    assert.equal(playground.rows[0]?.output_source, "DEEPSEEK_LIVE_PLAYGROUND");
  } finally {
    await client.end();
  }

  console.log(JSON.stringify({ status: "PASS", results }));
} finally {
  // Keep output, usage and version bindings; deleting them would orphan the ledger.
  console.log(JSON.stringify({ retention: "RETAINED_FOR_COST_AUDIT", executionIds }));
}
