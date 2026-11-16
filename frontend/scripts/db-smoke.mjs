import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createTestAccount, cleanupTestAccount } from "./test-account.mjs";

const { Client } = pg;
const baseUrl = (process.env.PROMPTMASTER_DEMO_API_BASE_URL || "http://127.0.0.1:3000").replace(
  /\/$/,
  "",
);
const connectionString = process.env.DATABASE_URL;

if (!connectionString) throw new Error("DATABASE_URL is required; configure frontend/.env.local.");
if (process.env.PROMPTMASTER_DEMO_API_ENABLED !== "true") {
  throw new Error("PROMPTMASTER_DEMO_API_ENABLED must be true for the local database smoke test.");
}

const client = new Client({ connectionString, connectionTimeoutMillis: 4000 });
const testTag = randomUUID();
const testTitle = `Stage 12 DB smoke ${testTag}`;
let promptId;
let originalDisplayName;
let profileChanged = false;
let account;

async function api(path, method = "GET", body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      origin: baseUrl,
      cookie: `pm_session=${account.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = response.status === 204 ? null : await response.json();
  assert.ok(
    response.ok,
    `${method} ${path} returned ${response.status}${payload?.error ? ` (${payload.error})` : ""}`,
  );
  return { response, payload };
}

try {
  await client.connect();
  account = await createTestAccount();
  const initialSnapshot = (await api("/api/demo/snapshot")).payload;
  originalDisplayName = initialSnapshot.profileName;

  const created = (
    await api("/api/prompts", "POST", {
      title: testTitle,
      taskType: "General",
      content: `Original source version ${testTag}.`,
    })
  ).payload;
  promptId = created.promptId;
  const versionOneId = created.versionId;
  assert.ok(promptId && versionOneId, "Prompt and initial version IDs are returned.");

  const versionTwo = (
    await api(`/api/prompts/${promptId}/versions`, "POST", {
      title: testTitle,
      content: `Edited source version ${testTag}.`,
      baseVersionId: versionOneId,
      parentVersionId: versionOneId,
      source: "STAGE12_DB_SMOKE",
    })
  ).payload;
  assert.equal(versionTwo.number, 2);

  const report = (
    await api(`/api/prompts/${promptId}/evaluations`, "POST", {
      versionId: versionTwo.versionId,
      rubricVersion: "stage12-db-smoke",
      layer1: { status: "INSUFFICIENT_INFORMATION", score: null, grade: null, dimensions: [] },
      layer2: { status: "NOT_AVAILABLE", score: null, grade: null, dimensions: [] },
    })
  ).payload;
  assert.equal(report.versionId, versionTwo.versionId);
  assert.deepEqual(report.layer2, {
    status: "NOT_AVAILABLE",
    score: null,
    grade: null,
    dimensions: [],
  });
  assert.deepEqual(report.layer3, {
    status: "NOT_EXECUTED",
    score: null,
    grade: null,
    dimensions: [],
  });

  await api(`/api/prompts/${promptId}/optimizations`, "POST", {
    sourceVersionId: versionTwo.versionId,
    proposedContent: `Optimized proposal ${testTag}.`,
  });
  await api(`/api/library/${promptId}`, "PUT");
  await api(`/api/favorites/${promptId}`, "PUT");
  await api("/api/playground/sessions", "POST", {
    promptId,
    versionId: versionTwo.versionId,
    outputs: [
      { name: "Demo Model A", text: "Simulated output A." },
      { name: "Demo Model B", text: "Simulated output B." },
    ],
  });
  const nextDisplayName = `Stage12 ${testTag}`;
  await api("/api/account/profile", "PATCH", { displayName: nextDisplayName });
  profileChanged = true;

  const restored = (
    await api(`/api/prompts/${promptId}/versions`, "POST", {
      title: testTitle,
      content: `Original source version ${testTag}.`,
      baseVersionId: versionTwo.versionId,
      parentVersionId: versionOneId,
      source: "RESTORED_FROM_V1_STAGE12_DB_SMOKE",
    })
  ).payload;
  assert.equal(restored.number, 3);

  const stale = await fetch(`${baseUrl}/api/prompts/${promptId}/versions`, {
    method: "POST",
    headers: {
      origin: baseUrl,
      "content-type": "application/json",
      cookie: `pm_session=${account.token}`,
    },
    body: JSON.stringify({
      content: "Stale write must be rejected.",
      baseVersionId: versionTwo.versionId,
      parentVersionId: versionTwo.versionId,
      source: "STAGE12_DB_SMOKE_STALE",
    }),
  });
  assert.equal(stale.status, 409, "Stale version writes are rejected as conflicts.");

  const snapshot = (await api("/api/demo/snapshot")).payload;
  const prompt = snapshot.prompts.find((item) => item.id === promptId);
  assert.equal(prompt.currentVersionId, restored.versionId);
  assert.ok(
    snapshot.versions.some((item) => item.id === versionOneId && item.promptId === promptId),
  );
  assert.ok(
    snapshot.versions.some(
      (item) => item.id === versionTwo.versionId && item.promptId === promptId,
    ),
  );
  assert.ok(
    snapshot.versions.some(
      (item) => item.id === restored.versionId && item.parentVersionId === versionOneId,
    ),
  );
  assert.ok(
    snapshot.reports.some(
      (item) => item.id === report.id && item.versionId === versionTwo.versionId,
    ),
  );
  assert.ok(snapshot.history.some((item) => item.versionId === restored.versionId));
  assert.ok(snapshot.libraryPromptIds.includes(promptId));
  assert.ok(snapshot.favorites.includes(promptId));
  assert.ok(
    snapshot.playgroundRuns.some(
      (item) => item.versionId === versionTwo.versionId && item.outputs.length === 2,
    ),
  );
  assert.equal(snapshot.profileName, nextDisplayName);

  const persistedOptimization = await client.query(
    `SELECT 1 FROM optimization_records
     WHERE prompt_id = $1 AND source_prompt_version_id = $2 AND proposed_content = $3
       AND source = 'MOCK_SIMULATED'`,
    [promptId, versionTwo.versionId, `Optimized proposal ${testTag}.`],
  );
  assert.equal(
    persistedOptimization.rowCount,
    1,
    "Optimization proposal is persisted against its source version.",
  );
  const persistedPlaygroundOutputs = await client.query(
    `SELECT count(*)::int AS count
     FROM model_comparison_results result
     JOIN playground_sessions session ON session.id = result.session_id
     WHERE session.prompt_id = $1 AND session.prompt_version_id = $2
       AND result.source = 'MOCK_SIMULATED'`,
    [promptId, versionTwo.versionId],
  );
  assert.equal(
    persistedPlaygroundOutputs.rows[0].count,
    2,
    "Both simulated model outputs persist.",
  );

  await api(`/api/library/${promptId}`, "DELETE");
  await api(`/api/favorites/${promptId}`, "DELETE");
  const afterRemoval = (await api("/api/demo/snapshot")).payload;
  assert.ok(!afterRemoval.libraryPromptIds.includes(promptId));
  assert.ok(!afterRemoval.favorites.includes(promptId));

  console.log(
    "PASS: real PostgreSQL API persistence, version/report/history links, mutations, and stale-write protection.",
  );
} finally {
  try {
    if (profileChanged && originalDisplayName) {
      await api("/api/account/profile", "PATCH", { displayName: originalDisplayName });
    }
  } finally {
    try {
      if (account) await cleanupTestAccount(account);
    } finally {
      await client.end().catch(() => {});
    }
  }
}
