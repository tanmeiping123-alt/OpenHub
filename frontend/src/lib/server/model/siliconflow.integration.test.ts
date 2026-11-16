import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_CATALOG } from "@/lib/model-catalog";
import { getPool, withTransaction } from "../db";
import { accountContext, type Actor } from "../identity-context";
import { createPrompt, createPromptVersion, getSnapshot } from "../repository";
import { readModelConfig } from "./model-config";
import {
  createPendingModelExecution,
  completeModelExecutionWithPrompt,
  completeSourceModelExecution,
  failModelExecution,
} from "./model-repository";
import { reserveModelQuota, markModelAttempt } from "./model-quota-repository";
import { generateLivePrompt } from "./model-service";
import { createSkillPlan, runSkillPlan } from "../skills/skill-workflow-service";
import type { LiveModelConfig, ProviderGenerateResult } from "./model-types";

let actor: Actor;
const models = MODEL_CATALOG.filter((m) => m.provider === "siliconflow");
const measured = {
  promptTokens: 20,
  completionTokens: 30,
  totalTokens: 50,
  promptCacheHitTokens: 5,
  reasoningTokens: 25,
};
const result = (model: string): ProviderGenerateResult => ({
  content: "Synthetic result · no provider request",
  resolvedModel: model,
  providerRequestId: "synthetic",
  usage: measured,
  latencyMs: 1,
});
const run = <T>(fn: () => Promise<T>) => accountContext.run(actor, fn);
const cfg = (modelKey = "zai-org/GLM-5.3-Flash") =>
  ({ ...readModelConfig(process.env, { modelKey }), maxOutputTokens: 128 }) as LiveModelConfig;
describe.skipIf(process.env.PROMPTMASTER_SILICONFLOW_DB_TEST !== "true")(
  "SiliconFlow disposable database (no provider network)",
  () => {
    beforeEach(async () => {
      expect(new URL(process.env.DATABASE_URL!).pathname).toMatch(
        /^\/promptmaster_sf_test_[a-f0-9]{12}$/,
      );
      const id = `usr_sf_${randomUUID()}`;
      actor = { id, email: `${id}@example.test`, role: "USER" };
      await withTransaction(async (c) => {
        await c.query(
          "INSERT INTO app_users(id,identity_key,account_kind) VALUES($1,'email:'||$2,'USER')",
          [actor.id, actor.email],
        );
        await c.query(
          "INSERT INTO regular_users(user_id,email,password_hash) VALUES($1,$2,'scrypt$synthetic-unused')",
          [actor.id, actor.email],
        );
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(() => {
          throw Error("Real network is forbidden in this test");
        }),
      );
    });
    afterAll(async () => {
      vi.unstubAllGlobals();
      if (process.env.PROMPTMASTER_SILICONFLOW_DB_TEST === "true") await getPool().end();
    });
    it.each(models)(
      "persists $key selection, usage and provider-specific new version provenance",
      async (m) =>
        run(async () => {
          const c = cfg(m.key);
          const pending = await createPendingModelExecution({
            config: c,
            purpose: "PROMPT_GENERATION",
            inputSha256: "a".repeat(64),
          });
          const saved = await completeModelExecutionWithPrompt({
            executionId: pending.executionId,
            title: "Synthetic",
            taskType: "Coding",
            result: result(m.model),
          });
          const e = (
            await getPool().query("SELECT * FROM model_executions WHERE id=$1", [
              pending.executionId,
            ])
          ).rows[0];
          expect(e).toMatchObject({
            provider: "siliconflow",
            requested_model: m.model,
            requested_strength: m.defaultStrength,
            output_token_limit: 128,
            reasoning_token_reserve: m.defaultStrength === "off" ? 0 : 32768,
            reasoning_tokens: 25,
            completion_tokens: 30,
            total_tokens: 50,
          });
          const snapshot = await getSnapshot();
          expect(snapshot.versions.find((v) => v.id === saved.versionId)).toMatchObject({
            source: "SILICONFLOW_LIVE_GENERATION",
            modelEvidence: {
              provider: "siliconflow",
              resolvedModel: m.model,
              strength: m.defaultStrength,
              usage: measured,
            },
          });
          expect(snapshot.history.find((h) => h.versionId === saved.versionId)?.source).toBe(
            "SILICONFLOW_LIVE_GENERATION",
          );
          expect(fetch).not.toHaveBeenCalled();
        }),
    );
    it("retains optimize proposal, exact-version playground evidence and advisory usage after reload", async () =>
      run(async () => {
        const p = await createPrompt({
          title: "Synthetic source",
          taskType: "Coding",
          content: "Original fixed baseline",
        });
        let optimizationId: string | undefined;
        for (const purpose of ["OPTIMIZATION", "PLAYGROUND", "EVALUATION_ADVICE"] as const) {
          const pending = await createPendingModelExecution({
            config: cfg(),
            purpose,
            inputSha256: "b".repeat(64),
            promptId: p.promptId,
            promptVersionId: p.versionId,
          });
          const saved = await completeSourceModelExecution({
            executionId: pending.executionId,
            purpose,
            promptId: p.promptId,
            promptVersionId: p.versionId,
            result: result(cfg().model),
          });
          if ("optimizationId" in saved) optimizationId = saved.optimizationId;
        }
        const snapshot = await getSnapshot();
        expect(snapshot.playgroundRuns[0]).toMatchObject({
          versionId: p.versionId,
          source: "SILICONFLOW_LIVE_PLAYGROUND",
          modelEvidence: { provider: "siliconflow", usage: measured },
          outputs: [{ source: "SILICONFLOW_LIVE_PLAYGROUND" }],
        });
        expect(snapshot.liveAdvice[0]).toMatchObject({
          provider: "siliconflow",
          strength: "default",
          usage: measured,
        });
        expect(snapshot.optimizationRecords[0].source).toBe("SILICONFLOW_LIVE_OPTIMIZATION");
        const applied = await createPromptVersion({
          promptId: p.promptId,
          content: result(cfg().model).content,
          baseVersionId: p.versionId,
          source: "SILICONFLOW_LIVE_OPTIMIZATION",
          optimizationId,
        });
        expect(applied?.versionId).not.toBe(p.versionId);
        expect(
          (await getSnapshot()).versions.find((v) => v.id === applied?.versionId)?.modelEvidence
            ?.usage,
        ).toEqual(measured);
        expect((await getSnapshot()).versions.find((v) => v.id === p.versionId)?.content).toBe(
          "Original fixed baseline",
        );
      }));
    it("binds native CNY immutable snapshots and reserves reasoning before dispatch", async () =>
      run(async () => {
        const prices = (
          await getPool().query(
            "SELECT * FROM model_pricing_snapshots WHERE provider='siliconflow' ORDER BY requested_model",
          )
        ).rows;
        expect(prices).toHaveLength(4);
        for (const p of prices) {
          expect(p.native_currency).toBe("CNY");
          expect(Number(p.budget_usd_per_native_unit)).toBe(0.2);
          expect(Number(p.output_usd_per_million)).toBeCloseTo(
            Number(p.native_output_per_million) * 0.2,
          );
        }
        await expect(
          getPool().query(
            "UPDATE model_pricing_snapshots SET native_input_per_million=0 WHERE id=$1",
            [prices[0].id],
          ),
        ).rejects.toThrow("immutable");
        const config = cfg();
        const pending = await createPendingModelExecution({
          config,
          purpose: "PROMPT_GENERATION",
          inputSha256: "c".repeat(64),
        });
        await reserveModelQuota({
          executionId: pending.executionId,
          config,
          serializedMessages: "x",
        });
        const row = (
          await getPool().query("SELECT * FROM model_executions WHERE id=$1", [pending.executionId])
        ).rows[0];
        expect(row.reserved_total_tokens).toBe(257 + 128 + 32768);
        expect(row.max_attempts).toBe(1);
        expect(row.pricing_snapshot_id).toBe("mps_sf_glm53flash_20261106");
        await markModelAttempt(pending.executionId);
        await completeModelExecutionWithPrompt({
          executionId: pending.executionId,
          title: "Synthetic accounted",
          taskType: "Coding",
          result: result(config.model),
        });
        const u = (
          await getPool().query("SELECT * FROM model_quota_usage_daily WHERE owner_user_id=$1", [
            actor.id,
          ])
        ).rows[0];
        expect(u.settled_tokens).toBe(50);
        expect(u.reserved_tokens).toBe(0);
        expect(Number(u.settled_cost_usd)).toBe(0.00001943);
      }));
    it("shares quota across models, serializes reservations, and holds unknown attempted costs", async () =>
      run(async () => {
        const config = { ...cfg(), dailyTokenLimit: 50000 };
        const ids = await Promise.all(
          [1, 2].map(() =>
            createPendingModelExecution({
              config,
              purpose: "PROMPT_GENERATION",
              inputSha256: "d".repeat(64),
            }),
          ),
        );
        const settled = await Promise.allSettled(
          ids.map((p) =>
            reserveModelQuota({ executionId: p.executionId, config, serializedMessages: "x" }),
          ),
        );
        expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        const id = ids[settled.findIndex((r) => r.status === "fulfilled")].executionId;
        await markModelAttempt(id);
        await failModelExecution(id, { code: "SYNTHETIC_UNKNOWN", message: "Synthetic timeout" });
        const row = (await getPool().query("SELECT * FROM model_executions WHERE id=$1", [id]))
          .rows[0];
        expect(row.quota_reservation_status).toBe("HELD");
        expect(row.reconciliation_status).toBe("REQUIRED");
        await expect(
          generateLivePrompt({
            goal: "Synthetic",
            taskType: "Coding",
            locale: "en",
            modelKey: "tencent/Hy4-preview",
          }),
        ).rejects.toMatchObject({ code: "MODEL_USER_QUOTA_EXCEEDED" });
        expect(fetch).not.toHaveBeenCalled();
      }));
    it("persists a real adapter timeout once and holds its unknown usage without creating a prompt", async () =>
      run(async () => {
        await getPool().query(
          "INSERT INTO model_quota_policies(owner_user_id,daily_token_limit,daily_cost_limit_usd,unlimited) VALUES($1,200000,0.25,true)",
          [actor.id],
        );
        // Only this isolated synthetic database is touched; the provider is mocked.
        vi.stubEnv("SILICONFLOW_MODEL_TIMEOUT_MS", "1000");
        const fetchMock = vi.fn(
          async (_url: RequestInfo | URL, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init!.signal!.addEventListener(
                "abort",
                () => reject(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
            }),
        );
        vi.stubGlobal("fetch", fetchMock);
        try {
          await expect(
            generateLivePrompt({
              goal: "Synthetic timeout; do not call a provider",
              taskType: "Coding",
              locale: "en",
              modelKey: "zai-org/GLM-5.3-Flash",
              maxOutputTokens: 128,
            }),
          ).rejects.toMatchObject({ code: "MODEL_REQUEST_TIMEOUT", retryable: false });
          const { rows } = await getPool().query(
            "SELECT * FROM model_executions WHERE owner_user_id=$1",
            [actor.id],
          );
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            status: "FAILED",
            error_code: "MODEL_REQUEST_TIMEOUT",
            provider_attempt_count: 1,
            quota_reservation_status: "HELD",
            reconciliation_status: "REQUIRED",
            output_text: null,
            total_tokens: null,
          });
          expect(rows[0].reserved_total_tokens).toBeGreaterThan(0);
          expect(fetchMock).toHaveBeenCalledTimes(1);
          expect(
            (await getPool().query("SELECT id FROM prompts WHERE owner_user_id=$1", [actor.id]))
              .rows,
          ).toHaveLength(0);
        } finally {
          vi.unstubAllEnvs();
        }
      }));
    it("binds Skills idempotency to the chosen model, strength and output limit", async () =>
      run(async () => {
        await getPool().query(
          "INSERT INTO model_quota_policies(owner_user_id,daily_token_limit,daily_cost_limit_usd,unlimited) VALUES($1,200000,0.25,true)",
          [actor.id],
        );
        const plan = await createSkillPlan({
          goal: "Plan a small implementation with checks",
          taskType: "Coding",
          locale: "en",
          matchingMode: "AUTO",
          selectedVersionIds: [],
        });
        const modelKey = "zai-org/GLM-5.3-Flash";
        const fetchMock = vi.fn(async () =>
          Response.json({
            id: "synthetic",
            model: modelKey,
            choices: [{ message: { content: "Synthetic adapted plan" }, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 20,
              completion_tokens: 30,
              total_tokens: 50,
              completion_tokens_details: { reasoning_tokens: 25 },
            },
          }),
        );
        vi.stubGlobal("fetch", fetchMock);
        const input = {
          planId: plan.id,
          purpose: "PROMPT_GENERATION" as const,
          modelKey,
          strength: "default" as const,
          maxOutputTokens: 128,
        };
        const key = randomUUID();
        const first = await runSkillPlan(input, key);
        expect(first.status).toBe("SUCCEEDED");
        expect((await runSkillPlan(input, key)).status).toBe("SUCCEEDED");
        for (const patch of [
          { modelKey: "deepseek-ai/DeepSeek-V4-Pro", strength: "off" as const },
          { maxOutputTokens: 256 },
        ])
          await expect(runSkillPlan({ ...input, ...patch }, key)).rejects.toMatchObject({
            code: "IDEMPOTENCY_CONFLICT",
          });
        expect(fetchMock).toHaveBeenCalledTimes(1);
      }));
  },
);
