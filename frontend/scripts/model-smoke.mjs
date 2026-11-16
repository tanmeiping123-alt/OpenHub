import assert from "node:assert/strict";
import { Client } from "pg";
import { liveSmokeAuth } from "./live-smoke-auth.mjs";

const baseUrl = process.env.PROMPTMASTER_MODEL_SMOKE_BASE_URL ?? "http://127.0.0.1:3000";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const marker = `stage-13a-1-smoke-${Date.now()}`;
let executionId;
let promptId;
let versionId;

try {
  const headers = await liveSmokeAuth(baseUrl);
  const response = await fetch(`${baseUrl}/api/ai/generate`, {
    method: "POST",
    headers,
    redirect: "error",
    body: JSON.stringify({
      goal: `Create a short reusable prompt that asks an assistant to return only the text ${marker}.`,
      taskType: "Writing",
      locale: "en",
    }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`Live model smoke failed: ${payload.error ?? `HTTP_${response.status}`}`);
  }

  executionId = payload.executionId;
  promptId = payload.promptId;
  versionId = payload.versionId;
  assert.equal(payload.executionMode, "LIVE");
  assert.equal(payload.provider, "deepseek");
  assert.equal(payload.requestedModel, "deepseek-flash");
  assert.equal(payload.productVersion, "DeepSeek-V4.1-Flash-1017");
  assert.ok(payload.content.length > 0);
  assert.ok(payload.usage.totalTokens > 0);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const execution = await client.query(
      `SELECT status, provider, requested_model, product_version, output_text,
              prompt_tokens, completion_tokens, total_tokens, prompt_id, prompt_version_id
       FROM model_executions WHERE id = $1`,
      [executionId],
    );
    assert.equal(execution.rowCount, 1);
    assert.equal(execution.rows[0].status, "SUCCEEDED");
    assert.equal(execution.rows[0].output_text, payload.content);
    assert.equal(execution.rows[0].total_tokens, payload.usage.totalTokens);
    assert.equal(execution.rows[0].prompt_id, promptId);
    assert.equal(execution.rows[0].prompt_version_id, versionId);

    const version = await client.query(
      `SELECT created_by, source, content
       FROM prompt_versions WHERE id = $1 AND prompt_id = $2`,
      [versionId, promptId],
    );
    assert.equal(version.rowCount, 1);
    assert.equal(version.rows[0].created_by, "deepseek-live");
    assert.equal(version.rows[0].source, "DEEPSEEK_LIVE_GENERATION");
    assert.equal(version.rows[0].content, payload.content);
  } finally {
    await client.end();
  }

  console.log(
    JSON.stringify({
      status: "PASS",
      executionMode: payload.executionMode,
      provider: payload.provider,
      requestedModel: payload.requestedModel,
      resolvedModel: payload.resolvedModel,
      productVersion: payload.productVersion,
      usage: payload.usage,
      latencyMs: payload.latencyMs,
    }),
  );
} finally {
  // Paid calls and their source records are audit evidence, not disposable fixtures.
  console.log(
    JSON.stringify({ retention: "RETAINED_FOR_COST_AUDIT", executionId, promptId, versionId }),
  );
}
