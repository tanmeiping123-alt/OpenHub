import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPool, withTransaction } from "../db";
import { finalizeModelQuota, markModelAttempt, reserveModelQuota } from "./model-quota-repository";
import type { LiveModelConfig, ModelUsage } from "./model-types";

const config: LiveModelConfig = {
  mode: "LIVE",
  provider: "deepseek",
  apiKey: "unused-no-network",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
  productVersion: "DeepSeek-V4.1-Flash-1017",
  timeoutMs: 1000,
  maxRetries: 1,
  maxOutputTokens: 100,
  dailyTokenLimit: 1000,
  dailyCostLimitUsd: 1,
  pricingWindow: "AUTO",
};
const usage: ModelUsage = { promptTokens: 257, completionTokens: 100, totalTokens: 357 };
let owners: string[] = [];
const prompts = new Map<string, { promptId: string; versionId: string }>();
async function pending(owner: string) {
  const id = `mex_quota_test_${randomUUID()}`;
  await withTransaction(async (c) => {
    await c.query(
      `INSERT INTO model_executions (id, owner_user_id, status, provider, requested_model,
      product_version, input_sha256) VALUES ($1,$2,'PENDING','deepseek','deepseek-flash','DeepSeek-V4.1-Flash-1017',$3)`,
      [id, owner, "a".repeat(64)],
    );
  });
  return id;
}
const reserve = (id: string, owner = owners[0], overrides = {}) =>
  reserveModelQuota(
    {
      executionId: id,
      config: { ...config, ...overrides },
      serializedMessages: "x",
    },
    owner,
  );
async function finish(id: string, owner: string, measured?: ModelUsage, success = false) {
  await withTransaction(async (c) => {
    const p = prompts.get(owner)!;
    await c.query(
      `UPDATE model_executions SET status=$2, resolved_model='deepseek-flash', output_text='synthetic',
      prompt_id=$3,prompt_version_id=$4,prompt_tokens=$5,completion_tokens=$6,total_tokens=$7,
      latency_ms=0,completed_at=now(),error_code=$8,error_message=$8 WHERE id=$1`,
      [
        id,
        success ? "SUCCEEDED" : "FAILED",
        p.promptId,
        p.versionId,
        measured?.promptTokens ?? null,
        measured?.completionTokens ?? null,
        measured?.totalTokens ?? null,
        success ? null : "SYNTHETIC_TEST",
      ],
    );
    await finalizeModelQuota(c, id, owner, measured);
  });
}
async function ledger(owner = owners[0]) {
  return (
    await getPool().query("SELECT * FROM model_quota_usage_daily WHERE owner_user_id=$1", [owner])
  ).rows[0];
}
async function execution(id: string) {
  return (await getPool().query("SELECT * FROM model_executions WHERE id=$1", [id])).rows[0];
}

describe.skipIf(process.env.PROMPTMASTER_QUOTA_DB_TEST !== "true")(
  "quota PostgreSQL integration (synthetic; no provider calls)",
  () => {
    beforeEach(async () => {
      owners = [`usr_quota_test_${randomUUID()}`, `usr_quota_test_${randomUUID()}`];
      await withTransaction(async (c) => {
        for (const owner of owners) {
          const promptId = `prm_${randomUUID()}`,
            versionId = `ver_${randomUUID()}`;
          prompts.set(owner, { promptId, versionId });
          await c.query(
            "INSERT INTO app_users (id,identity_key,account_kind) VALUES ($1,$1,'LOCAL_DEMO')",
            [owner],
          );
          await c.query(
            `INSERT INTO prompts (id,owner_user_id,kind,title,task_type,current_version_id)
          VALUES ($1,$2,'PERSONAL_PROMPT','Synthetic quota test','General',$3)`,
            [promptId, owner, versionId],
          );
          await c.query(
            `INSERT INTO prompt_versions (id,prompt_id,owner_user_id,version_number,title,content,created_by,source)
          VALUES ($1,$2,$3,1,'Synthetic quota test','Synthetic','test','SYNTHETIC_TEST')`,
            [versionId, promptId, owner],
          );
        }
      });
    });
    afterEach(async () => {
      await withTransaction(async (c) => {
        await c.query("DELETE FROM model_executions WHERE owner_user_id=ANY($1::text[])", [owners]);
        await c.query("DELETE FROM model_quota_usage_daily WHERE owner_user_id=ANY($1::text[])", [
          owners,
        ]);
        await c.query("DELETE FROM model_quota_policies WHERE owner_user_id=ANY($1::text[])", [
          owners,
        ]);
        await c.query(
          "UPDATE prompts SET current_version_id=NULL WHERE owner_user_id=ANY($1::text[])",
          [owners],
        );
        await c.query("DELETE FROM prompt_versions WHERE owner_user_id=ANY($1::text[])", [owners]);
        await c.query("DELETE FROM prompts WHERE owner_user_id=ANY($1::text[])", [owners]);
        await c.query("DELETE FROM app_users WHERE id=ANY($1::text[])", [owners]);
      });
      prompts.clear();
    });
    afterAll(async () => {
      await getPool().end();
    });
    it("serializes concurrent reservations and counts settled + reserved against the cap", async () => {
      const ids = await Promise.all([pending(owners[0]), pending(owners[0]), pending(owners[0])]);
      const results = await Promise.allSettled(ids.map((id) => reserve(id)));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(Number((await ledger()).reserved_tokens)).toBe(714);
      const index = results.findIndex((r) => r.status === "fulfilled");
      await markModelAttempt(ids[index], owners[0]);
      await finish(ids[index], owners[0], usage, true);
      expect(Number((await ledger()).settled_tokens)).toBe(357);
      await expect(reserve(await pending(owners[0]))).rejects.toMatchObject({
        code: "MODEL_USER_QUOTA_EXCEEDED",
      });
    });
    it("enforces the USD ceiling independently", async () => {
      await expect(
        reserve(await pending(owners[0]), owners[0], { dailyCostLimitUsd: 0.0001 }),
      ).rejects.toMatchObject({ code: "MODEL_USER_QUOTA_EXCEEDED" });
      expect(await ledger()).toBeUndefined();
    });
    it("uses owner policy as a ceiling and honors disabled access", async () => {
      const id = await pending(owners[0]);
      await getPool().query(
        "INSERT INTO model_quota_policies (owner_user_id,daily_token_limit,daily_cost_limit_usd,enabled) VALUES ($1,500,1,true)",
        [owners[0]],
      );
      await expect(reserve(id)).rejects.toMatchObject({ code: "MODEL_USER_QUOTA_EXCEEDED" });
      await getPool().query(
        "UPDATE model_quota_policies SET enabled=false WHERE owner_user_id=$1",
        [owners[0]],
      );
      await expect(reserve(id)).rejects.toMatchObject({ code: "MODEL_USER_DISABLED" });
    });
    it("honors an explicit unlimited policy while keeping disable controls", async () => {
      const id = await pending(owners[0]);
      await getPool().query(
        "INSERT INTO model_quota_policies (owner_user_id,daily_token_limit,daily_cost_limit_usd,unlimited) VALUES ($1,1,0,true)",
        [owners[0]],
      );
      await reserve(id);
      expect(await execution(id)).toMatchObject({ quota_reservation_status: "RESERVED" });
      expect(Number((await ledger()).reserved_tokens)).toBe(714);
      await getPool().query(
        "UPDATE model_quota_policies SET enabled=false WHERE owner_user_id=$1",
        [owners[0]],
      );
      await expect(reserve(await pending(owners[0]))).rejects.toMatchObject({
        code: "MODEL_USER_DISABLED",
      });
    });
    it("lets an unlimited account bypass the platform trial guard", async () => {
      const policy = (
        await getPool().query("SELECT daily_usd FROM billing_runtime_policy WHERE id=true")
      ).rows[0];
      try {
        await getPool().query("UPDATE billing_runtime_policy SET daily_usd=0 WHERE id=true");
        const blockedId = await pending(owners[0]);
        await expect(reserve(blockedId)).rejects.toMatchObject({
          code: "MODEL_PLATFORM_BUDGET_EXCEEDED",
        });
        await getPool().query(
          "INSERT INTO model_quota_policies (owner_user_id,daily_token_limit,daily_cost_limit_usd,unlimited) VALUES ($1,1000,1,true) ON CONFLICT (owner_user_id) DO UPDATE SET unlimited=true",
          [owners[0]],
        );
        const allowedId = await pending(owners[0]);
        await reserve(allowedId);
        expect(await execution(allowedId)).toMatchObject({
          quota_reservation_status: "RESERVED",
        });
      } finally {
        await getPool().query("UPDATE billing_runtime_policy SET daily_usd=$1 WHERE id=true", [
          policy.daily_usd,
        ]);
      }
    });
    it("isolates owners and rejects a foreign execution ID", async () => {
      const first = await pending(owners[0]),
        second = await pending(owners[1]);
      await expect(reserve(first, owners[1])).rejects.toMatchObject({
        code: "MODEL_EXECUTION_STATE_CONFLICT",
      });
      await Promise.all([reserve(first, owners[0]), reserve(second, owners[1])]);
      expect(Number((await ledger(owners[1])).reserved_tokens)).toBe(714);
    });
    it("releases all allowance when dispatch never started", async () => {
      const id = await pending(owners[0]);
      await reserve(id);
      await finish(id, owners[0]);
      expect(await ledger()).toMatchObject({
        reserved_tokens: 0,
        settled_tokens: 0,
        failed_executions: 1,
      });
      expect(await execution(id)).toMatchObject({
        quota_reservation_status: "RELEASED",
        reconciliation_status: "NOT_REQUIRED",
      });
    });
    it("holds ambiguous attempted failure and releases unused retries", async () => {
      const id = await pending(owners[0]);
      await reserve(id);
      await markModelAttempt(id, owners[0]);
      await finish(id, owners[0]);
      expect(await ledger()).toMatchObject({ reserved_tokens: 357, settled_tokens: 0 });
      expect(await execution(id)).toMatchObject({
        quota_reservation_status: "HELD",
        reconciliation_status: "REQUIRED",
      });
    });
    it("settles success atomically, once, while retaining unknown earlier attempts", async () => {
      const id = await pending(owners[0]);
      await reserve(id);
      await markModelAttempt(id, owners[0]);
      await markModelAttempt(id, owners[0]);
      await expect(markModelAttempt(id, owners[0])).rejects.toMatchObject({
        code: "MODEL_EXECUTION_STATE_CONFLICT",
      });
      await finish(id, owners[0], usage, true);
      const before = await ledger();
      expect(before).toMatchObject({
        reserved_tokens: 357,
        settled_tokens: 357,
        successful_executions: 1,
      });
      await withTransaction((c) => finalizeModelQuota(c, id, owners[0], usage));
      expect(await ledger()).toEqual(before);
    });
    it("retains measured usage even if the core write failed", async () => {
      const id = await pending(owners[0]);
      await reserve(id);
      await markModelAttempt(id, owners[0]);
      await finish(id, owners[0], usage);
      expect(await ledger()).toMatchObject({
        reserved_tokens: 0,
        settled_tokens: 357,
        failed_executions: 1,
      });
      expect(await execution(id)).toMatchObject({
        quota_reservation_status: "SETTLED",
        reconciliation_status: "PENDING_PROVIDER",
      });
    });
    it("rolls back quota settlement with a failed core transaction", async () => {
      const id = await pending(owners[0]);
      await reserve(id);
      await markModelAttempt(id, owners[0]);
      const before = await ledger();
      await expect(
        withTransaction(async (c) => {
          await finalizeModelQuota(c, id, owners[0], usage);
          throw new Error("rollback test");
        }),
      ).rejects.toThrow("rollback test");
      expect(await ledger()).toEqual(before);
      expect((await execution(id)).quota_reservation_status).toBe("RESERVED");
    });
    it("fails closed for missing prices, and prevents snapshot edits", async () => {
      const id = await pending(owners[0]);
      await getPool().query(
        "UPDATE model_executions SET requested_model='unpriced-model' WHERE id=$1",
        [id],
      );
      await expect(reserve(id, owners[0], { model: "unpriced-model" })).rejects.toMatchObject({
        code: "MODEL_PRICING_UNAVAILABLE",
      });
      await expect(
        withTransaction((c) =>
          c.query(
            "UPDATE model_pricing_snapshots SET output_usd_per_million=0 WHERE id='mps_deepseek_flash_1017_peak_20261105'",
          ),
        ),
      ).rejects.toThrow("immutable");
    });
  },
);
