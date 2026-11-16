// Explicit, local, real acceptance. Never invokes a model, executes Skill instructions,
// transfers demo content, or deletes retained import/review evidence.
// Supply credentials only over hidden stdin, never command arguments or this file.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import pg from "pg";
import { createTestAccount, cleanupTestAccount } from "./test-account.mjs";

const base = "http://127.0.0.1:3000";
const source = {
  repositoryOwner: "obra",
  repositoryName: "superpowers",
  path: "skills/writing-plans",
  ref: "22f0b463e7a5e579904dd6211a520321035526f7",
};
const key = "real-writing-plans-user-20261105-01";
const legacy = "skv_5767cb7b-fa2b-497d-88a9-693d0911e5e9";
const url = new URL(process.env.DATABASE_URL ?? "invalid:");
assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
assert.equal(url.pathname, "/promptmaster_dev");
const db = new pg.Client({ connectionString: url.toString() });
await db.connect();
if (process.stdin.isTTY) process.stdin.setRawMode(true); // No password echo.
const lines = createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator]();
const next = async () => {
  const line = await lines.next();
  assert.ok(!line.done, "Input closed; reconcile existing job before any new attempt.");
  return line.value;
};
const sessions = [];
let reader;
async function request(cookie, path, data, expected = 200, extra = {}) {
  // A fixed allowlist makes accidental paid calls impossible in this runner.
  assert.ok(
    /^\/api\/(?:auth\/(?:login|logout)|skills\/(?:imports(?:\/[a-z0-9_-]+)?|library)(?:\?versionId=skv_[a-f0-9-]+)?)$/.test(
      path,
    ),
  );
  const response = await fetch(base + path, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      Origin: base,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
      ...extra,
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(65000),
    redirect: "error",
  });
  const body = await response.json();
  assert.equal(
    response.status,
    expected,
    `Unexpected status for ${path}: ${body.error ?? body.errorCode ?? response.status}`,
  );
  return { body, cookie: response.headers.get("set-cookie")?.split(";")[0] };
}
async function login(credentials, role) {
  const result = await request(null, "/api/auth/login", credentials);
  credentials.password = "";
  assert.equal(result.body.user.role, role);
  assert.ok(result.cookie?.startsWith("pm_session="));
  sessions.push(result.cookie);
  return { cookie: result.cookie, user: result.body.user };
}
const overview = async (cookie) => (await request(cookie, "/api/skills/library")).body;
const has = (items, versionId) => items.some((v) => v.versionId === versionId);
const detail = async (cookie, versionId, expected = 200) =>
  (await request(cookie, `/api/skills/library?versionId=${versionId}`, undefined, expected)).body;
const adoptText = async (cookie, versionId, expected = 200) =>
  (await request(cookie, "/api/skills/library", { action: "use", versionId }, expected)).body;
async function fingerprintLegacy() {
  const rows = await db.query(
    `SELECT row_to_json(v) version,row_to_json(k) installation,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY path) FROM skill_resources r WHERE r.version_id=v.id) resources,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM skill_version_reviews r WHERE r.version_id=v.id) reviews,
    (SELECT jsonb_agg(to_jsonb(e)) FROM skill_library_entries e WHERE e.version_id=v.id) entries
    FROM skill_versions v JOIN skills k ON k.id=v.skill_id WHERE v.id=$1`,
    [legacy],
  );
  assert.equal(rows.rowCount, 1);
  return createHash("sha256").update(JSON.stringify(rows.rows)).digest("hex");
}
async function paidBaseline() {
  return (
    await db.query(`SELECT
    (SELECT count(*)::integer FROM model_executions) executions,
    (SELECT count(*)::integer FROM prompts) prompts,
    (SELECT count(*)::integer FROM prompt_versions) versions,
    (SELECT COALESCE(sum(settled_tokens),0)::text FROM model_quota_usage_daily) tokens,
    (SELECT COALESCE(sum(settled_cost_usd),0)::text FROM model_quota_usage_daily) cost,
    (SELECT COALESCE(sum(reserved_tokens),0)::text FROM model_quota_usage_daily) reserved`)
  ).rows[0];
}

try {
  const legacyBefore = await fingerprintLegacy();
  const baseline = await paidBaseline();
  console.log(JSON.stringify({ phase: "AWAIT_HIDDEN_CREDENTIALS", key, baseline }));
  let input = JSON.parse(await next());
  assert.equal(input.user.email, "1540744366@qq.com");
  assert.equal(input.admin.email, "admin@qq.com");
  const user = await login(input.user, "USER");
  const admin = await login(input.admin, "ADMIN");
  input = null;
  reader = await createTestAccount();
  const readerCookie = `pm_session=${reader.token}`;
  console.log(
    JSON.stringify({ phase: "AUTHENTICATED", userId: user.user.id, adminId: admin.user.id }),
  );
  assert.equal(await next(), "IMPORT");
  // Reuse the durable key after unknown responses; a terminal failure requires an
  // explicit new run/key, never automatic redispatch.
  const job = (
    await request(user.cookie, "/api/skills/imports", source, 200, {
      "Idempotency-Key": key,
      "x-personal-risk-acceptance": "personal-risk-v1",
    })
  ).body;
  console.log(JSON.stringify({ phase: "IMPORT_RESULT", ...job }));
  assert.equal(job.status, "REGISTERED", "Import did not complete; keep its evidence and stop.");
  const versionId = job.versionId;
  assert.notEqual(versionId, legacy);
  const own = await detail(user.cookie, versionId);
  assert.equal(own.ownerId, user.user.id);
  assert.equal(own.accessKind, "PERSONAL");
  assert.equal(own.source.commitSha, source.ref);
  assert.equal(own.mainSha256, "a6c67c1900064347c2a329990dd3c555657c51c3ec53b259a08aa01a2c26139a");
  assert.equal(own.manifestSha256, job.manifestSha256);
  assert.equal(own.resources.length, 2);
  assert.ok(own.resources.every((r) => !r.quarantined));
  assert.ok(!has((await overview(user.cookie)).library, versionId));
  const privateUse = await adoptText(user.cookie, versionId);
  assert.equal(privateUse.accessKind, "PERSONAL");
  for (const cookie of [admin.cookie, readerCookie]) {
    const list = await overview(cookie);
    assert.ok(
      [list.library, list.personal, list.pending, list.history].every(
        (group) => !has(group, versionId),
      ),
    );
    await detail(cookie, versionId, 404);
    await adoptText(cookie, versionId, 404);
  }
  const jobReplay = (
    await request(user.cookie, "/api/skills/imports", source, 200, {
      "Idempotency-Key": key,
      "x-personal-risk-acceptance": "personal-risk-v1",
    })
  ).body;
  assert.deepEqual(jobReplay, job);
  await request(admin.cookie, `/api/skills/imports/${job.jobId}`, undefined, 404);
  console.log(
    JSON.stringify({
      phase: "PRIVATE_VERIFIED",
      versionId,
      privateUseEventId: privateUse.useEventId,
      reviewMaterial: {
        body: own.body,
        source: own.source,
        warnings: own.warnings,
        resources: own.resources,
      },
    }),
  );
  assert.equal(await next(), "RECOMMEND");
  const recommendation = { action: "recommend", versionId, shareAccepted: true };
  const submission = (await request(user.cookie, "/api/skills/library", recommendation)).body;
  assert.equal(submission.status, "PENDING");
  assert.deepEqual(
    (await request(user.cookie, "/api/skills/library", recommendation)).body,
    submission,
  );
  assert.ok(has((await overview(admin.cookie)).pending, versionId));
  assert.equal((await detail(admin.cookie, versionId)).accessKind, "REVIEW_ONLY");
  await adoptText(admin.cookie, versionId, 403);
  await detail(readerCookie, versionId, 404);
  await adoptText(readerCookie, versionId, 404);
  const note =
    "Approved pinned writing-plans as bounded, untrusted planning text only. Verified source commit, main/manifest hashes and retained MIT notice. Referenced worktree, subagent and other Skills are not imported or granted; no script/tool/model is executed by approval. Not a security certification or effectiveness guarantee.";
  const review = { action: "review", submissionId: submission.id, decision: "APPROVED", note };
  await request(user.cookie, "/api/skills/library", review, 403);
  console.log(
    JSON.stringify({
      phase: "RECOMMENDATION_VERIFIED_AWAIT_EXPLICIT_APPROVAL",
      submissionId: submission.id,
      versionId,
      note,
    }),
  );
  assert.equal(await next(), "APPROVE_REVIEWED_TEXT");
  const approval = (await request(admin.cookie, "/api/skills/library", review)).body;
  assert.equal(approval.status, "APPROVED");
  assert.deepEqual((await request(admin.cookie, "/api/skills/library", review)).body, approval);
  for (const cookie of [user.cookie, admin.cookie, readerCookie]) {
    assert.ok(has((await overview(cookie)).library, versionId));
    const shared = await detail(cookie, versionId);
    assert.equal(shared.accessKind, "LIBRARY");
    assert.equal(shared.body, own.body);
    assert.equal(shared.publicationKind, "REVIEW_APPROVED");
  }
  const ordinaryUse = await adoptText(user.cookie, versionId);
  const adminUse = await adoptText(admin.cookie, versionId);
  assert.equal(ordinaryUse.accessKind, "LIBRARY");
  assert.equal(adminUse.accessKind, "LIBRARY");
  assert.equal(ordinaryUse.adoptionText, adminUse.adoptionText);
  assert.ok(ordinaryUse.loadedResources.some((r) => r.path === "references/SOURCE-LICENSE.txt"));
  const legacyAfter = await fingerprintLegacy();
  assert.equal(legacyAfter, legacyBefore);
  const after = await paidBaseline();
  assert.deepEqual(
    after,
    baseline,
    "Concurrent business/model activity: investigate before claiming zero delta.",
  );
  const state = (
    await db.query(
      `SELECT k.enabled,k.pinned_version_id,r.status
    FROM skills k JOIN skill_versions v ON v.skill_id=k.id JOIN skill_version_reviews r ON r.version_id=v.id WHERE v.id=$1`,
      [versionId],
    )
  ).rows[0];
  assert.equal(state.enabled, false);
  assert.equal(state.pinned_version_id, null);
  assert.equal(state.status, "PENDING_REVIEW");
  console.log(
    JSON.stringify(
      {
        phase: "PASS",
        source,
        key,
        job,
        submissionId: submission.id,
        ownerId: user.user.id,
        reviewerId: admin.user.id,
        publicationKind: "REVIEW_APPROVED",
        useEvents: {
          private: privateUse.useEventId,
          sharedUser: ordinaryUse.useEventId,
          sharedAdmin: adminUse.useEventId,
        },
        runtime: state,
        legacyUnchanged: legacyAfter,
        paidBaseline: baseline,
        paidAfter: after,
        independentReader:
          "private and pending: list absent, detail/use 404; shared: list/detail LIBRARY",
        verifiedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
} catch (error) {
  // Do not dump Request/Response objects or credentials on unexpected errors.
  console.error(
    JSON.stringify({
      phase: "STOPPED",
      reason: error instanceof assert.AssertionError ? error.message : "LOCAL_ACCEPTANCE_FAILED",
      key,
    }),
  );
  process.exitCode = 1;
} finally {
  for (const cookie of sessions) await request(cookie, "/api/auth/logout", {}).catch(() => {});
  if (reader) await cleanupTestAccount(reader);
  await db.end();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  await lines.return?.();
}
