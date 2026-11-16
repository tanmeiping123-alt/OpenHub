import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_CATALOG, modelOutputLimit, liveSource } from "@/lib/model-catalog";
import { paymentConfig } from "@/lib/billing-policy";
import { ensureDatabaseReady, getPool, withTransaction } from "../db";
import { accountContext, type Actor } from "../identity-context";
import { createAccountInTransaction } from "../accounts";
import { billingCommand, grantOrder, parseBillingCommand } from "../billing/service";
import { createPrompt, createPromptVersion, getSnapshot } from "../repository";
import { generateLivePrompt, generateLiveSourceModel } from "./model-service";
import { getPlaygroundRequestStatus } from "./model-repository";
import { legacyModelEvaluationPrinciples } from "@/lib/model-evaluation";
import { MODEL_POLICY_VERSION, sha256 } from "./model-policy";
import { estimatePromptTokens } from "./model-pricing";
import { syntheticSkill } from "../skills/skill-fixture";
import { registerOfflineSkillInTransaction } from "../skills/skill-registry";
import { createSkillPlan, runSkillPlan } from "../skills/skill-workflow-service";
import { getModelQuotaSummary } from "./model-quota-repository";
import { readModelConfig } from "./model-config";
import { syntheticEvaluation } from "@/lib/model-evaluation-fixture";

// All service calls below use the real adapter and database, but a strictly mocked
// supplier. Synthetic receipt/entitlement records live only in the disposable DB.
describe.skipIf(process.env.PROMPTMASTER_SILICONFLOW_DB_TEST !== "true")(
  "five-model source and Skills workflows (isolated, zero supplier network)",
  () => {
    let actor: Actor;
    beforeEach(async () => {
      expect(new URL(process.env.DATABASE_URL!).pathname).toMatch(
        /^\/promptmaster_(?:sf|core)_test_[a-f0-9]{12}$/,
      );
      await ensureDatabaseReady();
      await getPool().query(
        "UPDATE billing_runtime_policy SET daily_usd=1000,period_usd=1000 WHERE id=true",
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(() => {
          throw Error("Supplier network forbidden");
        }),
      );
      await withTransaction(async (c) => {
        const admin = await createAccountInTransaction(
          c,
          `admin-${randomUUID()}@example.test`,
          "scrypt$synthetic-unused",
          "ADMIN",
        );
        actor = await createAccountInTransaction(
          c,
          `model-${randomUUID()}@example.test`,
          "scrypt$synthetic-unused",
          "USER",
        );
        const payment = {
          ...paymentConfig({}),
          ready: true,
          receiverAccount: "synthetic",
          receiverHint: "Synthetic only",
          refundContact: "No funds",
          qrPath: "/payments/synthetic.png",
        };
        const command = (who: Actor, body: Record<string, string>) =>
          billingCommand(c, who, parseBillingCommand(body), payment);
        await command(admin, {
          action: "allowlist_add",
          email: actor.email,
          reason: "Synthetic model workflow test",
        });
        const order = (await command(actor, {
          action: "create_order",
          requestKey: randomUUID(),
        })) as { id: string };
        await command(admin, {
          action: "review_order",
          orderId: order.id,
          transactionId: randomUUID(),
          receivedAt: new Date().toISOString(),
          receiverAccount: payment.receiverAccount,
          amountFen: "1",
          currency: "CNY",
          note: "Synthetic receipt in disposable database, no payment",
          verified: "CONFIRMED_REAL_RECEIPT",
        });
        await grantOrder(c, admin, order.id);
        // Synthetic unlimited allowance exercises successful maximum-output calls.
        // Separate cases below retain ordinary Free/Pro quota denial coverage.
        await c.query(
          "INSERT INTO model_quota_policies(owner_user_id,daily_token_limit,daily_cost_limit_usd,unlimited) VALUES($1,200000,0.25,true)",
          [actor.id],
        );
        await command(admin, {
          action: "allowlist_remove",
          email: actor.email,
          reason: "Synthetic checkout complete; retain entitlement",
        });
      });
    });
    afterAll(async () => {
      vi.unstubAllGlobals();
      if (process.env.PROMPTMASTER_SILICONFLOW_DB_TEST === "true") await getPool().end();
    });
    it.each(MODEL_CATALOG.flatMap((model) => ["Free", "Pro"].map((tier) => ({ model, tier }))))(
      "$tier users retain the complete $model.key limit and fail quota before supplier dispatch",
      async ({ model, tier }) =>
        accountContext.run(actor, async () => {
          await getPool().query(
            "UPDATE model_quota_policies SET unlimited=false WHERE owner_user_id=$1",
            [actor.id],
          );
          if (tier === "Free")
            await getPool().query(
              "UPDATE billing_entitlements SET revoked_at=clock_timestamp() WHERE owner_user_id=$1",
              [actor.id],
            );
          await expect(
            generateLivePrompt({
              goal: "Say hello",
              taskType: "General",
              locale: "en",
              modelKey: model.key,
              maxOutputTokens: 128,
            }),
          ).rejects.toMatchObject({
            code: expect.stringMatching(/^MODEL_(USER|PERIOD)_QUOTA_EXCEEDED$/),
          });
          const rows = (
            await getPool().query("SELECT * FROM model_executions WHERE owner_user_id=$1", [
              actor.id,
            ])
          ).rows;
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            output_token_limit: modelOutputLimit(model.key),
            provider_attempt_count: 0,
            status: "FAILED",
            quota_reservation_status: "NOT_RESERVED",
          });
          expect(fetch).not.toHaveBeenCalled();
        }),
    );
    const setupSupplier = (m: (typeof MODEL_CATALOG)[number]) => {
      const calls: { url: string; body: Record<string, unknown> }[] = [];
      const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        const expected =
          m.provider === "deepseek"
            ? "https://api.deepseek.com/chat/completions"
            : "https://api.siliconflow.cn/v1/chat/completions";
        expect(String(url)).toBe(expected);
        expect(body.model).toBe(m.model);
        expect(body.max_tokens).toBe(modelOutputLimit(m.key));
        if (m.provider === "deepseek") expect(body.thinking).toEqual({ type: "disabled" });
        calls.push({ url: String(url), body });
        return Response.json({
          id: `synthetic-${calls.length}`,
          model: m.model,
          choices: [
            {
              message: {
                content: `Synthetic result ${calls.length} for ${m.key}; no supplier request`,
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 30,
            total_tokens: 50,
            completion_tokens_details: { reasoning_tokens: m.defaultStrength === "off" ? 0 : 25 },
          },
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      return { calls, fetchMock };
    };

    it.each(["Free", "Pro"])(
      "%s can complete maximum-output calls with finite quotas and a mocked supplier",
      async (tier) => {
        await accountContext.run(actor, async () => {
          await getPool().query("DELETE FROM model_quota_policies WHERE owner_user_id=$1", [
            actor.id,
          ]);
          if (tier === "Free")
            await getPool().query(
              "UPDATE billing_entitlements SET revoked_at=clock_timestamp() WHERE owner_user_id=$1",
              [actor.id],
            );
          const supplier = setupSupplier(MODEL_CATALOG[0]);
          const result = await generateLivePrompt({
            goal: "Say hello",
            taskType: "General",
            locale: "en",
          });
          const execution = (
            await getPool().query("SELECT * FROM model_executions WHERE id=$1", [
              result.executionId,
            ])
          ).rows[0];
          expect(execution).toMatchObject({
            status: "SUCCEEDED",
            output_token_limit: 393216,
            quota_reservation_status: "SETTLED",
            total_tokens: 50,
          });
          expect(execution.quota_plan_snapshot.tier).toBe(tier);
          const policy = (
            await getPool().query("SELECT * FROM model_quota_policies WHERE owner_user_id=$1", [
              actor.id,
            ])
          ).rows[0];
          expect(policy.unlimited).toBe(false);
          expect(supplier.fetchMock).toHaveBeenCalledTimes(1);
          const source = await createPrompt({
            title: "Finite workflow",
            taskType: "General",
            content: result.content,
          });
          const proposal = await generateLiveSourceModel({
            purpose: "OPTIMIZATION",
            promptId: source.promptId,
            versionId: source.versionId,
            locale: "en",
          });
          const saved = await createPromptVersion({
            promptId: source.promptId,
            title: "Finite workflow",
            content: proposal.content,
            baseVersionId: source.versionId,
            parentVersionId: source.versionId,
            source: liveSource(proposal.provider, "OPTIMIZATION"),
            optimizationId: proposal.optimizationId,
          });
          expect(saved).toBeTruthy();
          const run = await generateLiveSourceModel({
            purpose: "PLAYGROUND",
            promptId: source.promptId,
            versionId: saved!.versionId,
            locale: "en",
            playgroundRequestKey: randomUUID(),
          });
          expect(run.usage.totalTokens).toBe(50);
          expect(supplier.fetchMock).toHaveBeenCalledTimes(3);
          expect(
            (
              await getPool().query(
                "SELECT count(*)::int n FROM model_executions WHERE owner_user_id=$1 AND status='SUCCEEDED' AND quota_reservation_status='SETTLED'",
                [actor.id],
              )
            ).rows[0].n,
          ).toBe(3);
        });
      },
    );
    it("availability reads do not create policies, usage or supplier attempts", async () => {
      await accountContext.run(actor, async () => {
        await getPool().query("DELETE FROM model_quota_policies WHERE owner_user_id=$1", [
          actor.id,
        ]);
        const cfg = readModelConfig();
        if (cfg.mode !== "LIVE") throw Error("Synthetic config missing");
        const summary = await getModelQuotaSummary(cfg, true);
        expect(summary.unlimited).toBe(false);
        for (const table of [
          "model_quota_policies",
          "model_quota_usage_daily",
          "model_executions",
        ]) {
          expect(
            (
              await getPool().query(
                `SELECT count(*)::int AS count FROM ${table} WHERE owner_user_id=$1`,
                [actor.id],
              )
            ).rows[0].count,
          ).toBe(0);
        }
        expect(fetch).not.toHaveBeenCalled();
      });
    });

    it.each(MODEL_CATALOG)(
      "$key recovers a Playground receipt and immutable original response without a second dispatch",
      async (m) => {
        await accountContext.run(actor, async () => {
          const source = await createPrompt({
            title: "Playground recovery",
            taskType: "General",
            content: "Say hello.",
          });
          const supplier = setupSupplier(m);
          const input = {
            purpose: "PLAYGROUND" as const,
            promptId: source.promptId,
            versionId: source.versionId,
            locale: "en" as const,
            modelKey: m.key,
            strength: m.defaultStrength,
            maxOutputTokens: 128,
            playgroundRequestKey: randomUUID(),
          };
          const original = await generateLiveSourceModel(input);
          expect(await generateLiveSourceModel(input)).toEqual(original);
          expect(supplier.fetchMock).toHaveBeenCalledTimes(1);
          const row = (
            await getPool().query("SELECT * FROM model_executions WHERE id=$1", [
              original.executionId,
            ])
          ).rows[0];
          expect(row).toMatchObject({
            playground_request_key: input.playgroundRequestKey,
            evaluation_request_key: null,
            evaluation_principles: null,
            provider_attempt_count: 1,
            quota_reservation_status: "SETTLED",
          });
          expect(await getPlaygroundRequestStatus(input.playgroundRequestKey)).toEqual({
            status: "SUCCEEDED",
            executionId: original.executionId,
            result: original,
          });
          for (const change of [
            { locale: "zh-CN" as const },
            {
              modelKey:
                m.key === MODEL_CATALOG[0].key ? MODEL_CATALOG[1].key : MODEL_CATALOG[0].key,
              strength:
                m.key === MODEL_CATALOG[0].key
                  ? MODEL_CATALOG[1].defaultStrength
                  : MODEL_CATALOG[0].defaultStrength,
            },
          ])
            await expect(generateLiveSourceModel({ ...input, ...change })).rejects.toMatchObject({
              code: "MODEL_PLAYGROUND_REQUEST_CONFLICT",
            });
          expect(supplier.fetchMock).toHaveBeenCalledTimes(1);
          const snapshot = await getSnapshot();
          expect(
            snapshot.playgroundRuns.find((r) => r.executionId === original.executionId),
          ).toMatchObject({
            id: original.sessionId,
            createdAt: expect.any(String),
            modelEvidence: {
              finishReason: original.finishReason,
              latencyMs: original.latencyMs,
              createdAt: original.createdAt,
              usage: original.usage,
            },
          });
          for (const [column, value] of [
            ["playground_request_key", randomUUID()],
            ["purpose", "EVALUATION_ADVICE"],
            ["requested_model", "another-model"],
            ["output_token_limit", 129],
            ["output_text", "rewritten"],
            ["latency_ms", 99999],
            ["status", "PENDING"],
            ["request_identity_sha256", "f".repeat(64)],
          ])
            await expect(
              getPool().query(`UPDATE model_executions SET ${column}=$2 WHERE id=$1`, [
                original.executionId,
                value,
              ]),
            ).rejects.toMatchObject({ code: "23514" });
          const counts = async () =>
            (
              await getPool().query(
                "SELECT (SELECT count(*) FROM model_executions WHERE owner_user_id=$1) AS executions,(SELECT count(*) FROM playground_sessions WHERE owner_user_id=$1) AS sessions,(SELECT sum(reserved_tokens+settled_tokens) FROM model_quota_usage_daily WHERE owner_user_id=$1) AS quota",
                [actor.id],
              )
            ).rows[0];
          const beforeRead = await counts();
          expect(await getPlaygroundRequestStatus(randomUUID())).toEqual({ status: "NOT_FOUND" });
          expect(await getPlaygroundRequestStatus(input.playgroundRequestKey)).toMatchObject({
            status: "SUCCEEDED",
          });
          expect(await counts()).toEqual(beforeRead);
          await accountContext.run({ ...actor, id: randomUUID() }, async () => {
            expect(await getPlaygroundRequestStatus(input.playgroundRequestKey)).toEqual({
              status: "NOT_FOUND",
            });
          });
        });
      },
    );

    it("never redispatches concurrent pending or failed Playground keys and disables configured retries", async () => {
      await accountContext.run(actor, async () => {
        const source = await createPrompt({
          title: "Pending Playground",
          taskType: "General",
          content: "Say hello.",
        });
        const input = {
          purpose: "PLAYGROUND" as const,
          promptId: source.promptId,
          versionId: source.versionId,
          locale: "en" as const,
          maxOutputTokens: 128,
          playgroundRequestKey: randomUUID(),
        };
        let release!: () => void;
        let dispatched!: () => void;
        const ready = new Promise<void>((resolve) => {
          dispatched = resolve;
        });
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const supplier = vi.fn(async () => {
          dispatched();
          await held;
          return Response.json(
            { error: { message: "Synthetic temporary failure" } },
            { status: 503 },
          );
        });
        vi.stubGlobal("fetch", supplier);
        const oldRetries = process.env.PROMPTMASTER_MODEL_MAX_RETRIES;
        process.env.PROMPTMASTER_MODEL_MAX_RETRIES = "2";
        try {
          const running = generateLiveSourceModel(input);
          // Attach immediately so the expected failure cannot become an unhandled rejection.
          const completion = running.catch((error: unknown) => error);
          await ready;
          const status = await getPlaygroundRequestStatus(input.playgroundRequestKey);
          expect(status).toMatchObject({ status: "PENDING", executionId: expect.any(String) });
          try {
            await expect(generateLiveSourceModel(input)).rejects.toMatchObject({
              code: "MODEL_PLAYGROUND_PENDING",
            });
          } finally {
            release();
          }
          expect(await completion).toMatchObject({
            executionId: "executionId" in status ? status.executionId : undefined,
          });
          const failed = await getPlaygroundRequestStatus(input.playgroundRequestKey);
          expect(failed).toMatchObject({
            status: "FAILED",
            executionId: expect.any(String),
            errorCode: expect.any(String),
          });
          await expect(generateLiveSourceModel(input)).rejects.toMatchObject({
            code: "MODEL_PLAYGROUND_PREVIOUSLY_FAILED",
          });
          expect(supplier).toHaveBeenCalledTimes(1);
          const saved = (
            await getPool().query(
              "SELECT provider_attempt_count,evaluation_request_key FROM model_executions WHERE playground_request_key=$1 AND owner_user_id=$2",
              [input.playgroundRequestKey, actor.id],
            )
          ).rows[0];
          expect(saved).toEqual({ provider_attempt_count: 1, evaluation_request_key: null });
        } finally {
          release();
          if (oldRetries === undefined) delete process.env.PROMPTMASTER_MODEL_MAX_RETRIES;
          else process.env.PROMPTMASTER_MODEL_MAX_RETRIES = oldRetries;
        }
      });
    });

    it("snapshots exactly dispatched messages for quota and digest, saves descriptor separately, and guards evidence", async () => {
      await accountContext.run(actor, async () => {
        const supplier = setupSupplier(MODEL_CATALOG[0]);
        const descriptor = { purposes: ["build" as const], tags: ["PRIVATE_DESCRIPTOR_ONLY"] };
        const generated = await generateLivePrompt({
          goal: "Write a greeting. Preserve 42 USD and {{name}}.",
          taskType: "General",
          locale: "en",
          descriptor,
          maxOutputTokens: 128,
        });
        const saved = (
          await getPool().query("SELECT * FROM model_executions WHERE id=$1", [
            generated.executionId,
          ])
        ).rows[0];
        const messages = JSON.stringify(supplier.calls[0].body.messages);
        expect(saved.model_policy_version).toBe(MODEL_POLICY_VERSION);
        expect(saved.dispatched_messages_sha256).toBe(sha256(messages));
        expect(saved.per_attempt_tokens).toBe(estimatePromptTokens(messages) + modelOutputLimit());
        expect(saved.input_sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(messages).not.toContain("PRIVATE_DESCRIPTOR_ONLY");
        expect(
          (
            await getPool().query("SELECT descriptor FROM prompts WHERE id=$1", [
              generated.promptId,
            ])
          ).rows[0].descriptor,
        ).toEqual(descriptor);
        for (const column of ["model_policy_version", "dispatched_messages_sha256", "input_sha256"])
          await expect(
            getPool().query(`UPDATE model_executions SET ${column}=$2 WHERE id=$1`, [
              generated.executionId,
              column === "model_policy_version" ? "other-policy" : "b".repeat(64),
            ]),
          ).rejects.toMatchObject({ code: "23514" });
        expect(supplier.fetchMock).toHaveBeenCalledTimes(1);
      });
    });

    it("recovers immutable v1 successes and blocks old unknown/failed requests after a policy upgrade", async () => {
      await accountContext.run(actor, async () => {
        const sourceContent = "Summarize this supplied paragraph.";
        const source = await createPrompt({
          title: "Historical report",
          taskType: "General",
          content: sourceContent,
        });
        const principles = legacyModelEvaluationPrinciples("General", "en");
        const historicalReport = {
          principlesVersion: "prompt-review-principles-v1",
          summary: "Historical synthetic report",
          layer1: [],
          layer2: [],
          layer2Status: "NOT_AVAILABLE",
          layer3: { status: "NOT_EXECUTED", executionId: null },
          suggestions: [],
          nextChecks: ["Review supplied paragraph"],
        };
        const oldHash = createHash("sha256")
          .update(
            JSON.stringify({
              goal: sourceContent,
              taskType: "General",
              locale: "en",
              kind: "EVALUATION_REPORT",
              sourceContent,
              modelKey: "deepseek-direct",
              strength: "off",
              maxOutputTokens: 1200,
              evaluationPrinciples: principles,
            }),
          )
          .digest("hex");
        const supplier = vi.fn(() => {
          throw new Error("Historical requests must never reach a supplier");
        });
        vi.stubGlobal("fetch", supplier);
        for (const status of ["SUCCEEDED", "PENDING", "FAILED"] as const) {
          const key = randomUUID();
          const id = `mex_${randomUUID()}`;
          await getPool().query(
            `INSERT INTO model_executions(id,owner_user_id,purpose,execution_mode,status,provider,requested_model,product_version,input_sha256,prompt_id,prompt_version_id,evaluation_request_key,evaluation_principles,evaluation_report,output_text,resolved_model,prompt_tokens,completion_tokens,total_tokens,latency_ms,completed_at,error_code,error_message,requested_strength,output_token_limit)
            VALUES($1,$2,'EVALUATION_REPORT','LIVE',$3,'deepseek','deepseek-flash','DeepSeek-V4.1-Flash-1017',$4,$5,$6,$7,$8,$9,$10,'deepseek-flash',1,1,2,1,$11,$12,$13,'off',1200)`,
            [
              id,
              actor.id,
              status,
              oldHash,
              source.promptId,
              source.versionId,
              key,
              JSON.stringify(principles),
              status === "SUCCEEDED" ? JSON.stringify(historicalReport) : null,
              status === "SUCCEEDED" ? "Historical raw output" : null,
              status === "PENDING" ? null : new Date(),
              status === "FAILED" ? "MODEL_REQUEST_TIMEOUT" : null,
              status === "FAILED" ? "Historical outcome unknown" : null,
            ],
          );
          const request = {
            purpose: "EVALUATION_REPORT" as const,
            promptId: source.promptId,
            versionId: source.versionId,
            locale: "en" as const,
            evaluationRequestKey: key,
          };
          if (status === "SUCCEEDED") {
            const result = await generateLiveSourceModel(request);
            expect(result.executionId).toBe(id);
            expect(result.evaluation).toEqual({
              ...historicalReport,
              principlesSnapshot: principles,
            });
            expect(result.content).toBe("Historical raw output");
          } else
            await expect(generateLiveSourceModel(request)).rejects.toMatchObject({
              code:
                status === "PENDING"
                  ? "MODEL_EVALUATION_PENDING"
                  : "MODEL_EVALUATION_PREVIOUSLY_FAILED",
              executionId: id,
            });
          const unchanged = (
            await getPool().query(
              "SELECT model_policy_version,dispatched_messages_sha256,input_sha256 FROM model_executions WHERE id=$1",
              [id],
            )
          ).rows[0];
          expect(unchanged).toEqual({
            model_policy_version: null,
            dispatched_messages_sha256: null,
            input_sha256: oldHash,
          });
          await expect(
            getPool().query(
              "UPDATE model_executions SET model_policy_version='invented',dispatched_messages_sha256=$2 WHERE id=$1",
              [id, "c".repeat(64)],
            ),
          ).rejects.toMatchObject({ code: "23514" });
        }
        expect(supplier).not.toHaveBeenCalled();
      });
    });

    it("resolves automatic output from saved task content and reserves direct reasoning only once", async () => {
      vi.stubEnv("PROMPTMASTER_MODEL_MAX_OUTPUT_TOKENS", "auto");
      try {
        await accountContext.run(actor, async () => {
          const source = await createPrompt({
            title: "Synthetic adaptive HTML task",
            taskType: "Coding",
            content:
              "Build a complete HTML document with an SVG pelican riding a bicycle animation.",
          });
          const supplier = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body));
            expect(body.max_tokens).toBeGreaterThanOrEqual(16384);
            expect(body.thinking).toEqual({ type: "enabled" });
            expect(body.reasoning_effort).toBe("low");
            return Response.json({
              model: "deepseek-flash",
              choices: [
                { message: { content: "Synthetic animation output" }, finish_reason: "stop" },
              ],
              usage: {
                prompt_tokens: 20,
                completion_tokens: 30,
                total_tokens: 50,
                completion_tokens_details: { reasoning_tokens: 25 },
              },
            });
          });
          vi.stubGlobal("fetch", supplier);
          const input = {
            purpose: "PLAYGROUND" as const,
            promptId: source.promptId,
            versionId: source.versionId,
            locale: "en" as const,
            strength: "low" as const,
            playgroundRequestKey: randomUUID(),
          };
          const result = await generateLiveSourceModel(input);
          expect((await generateLiveSourceModel(input)).executionId).toBe(result.executionId);
          const row = (
            await getPool().query("SELECT * FROM model_executions WHERE id=$1", [
              result.executionId,
            ])
          ).rows[0];
          const sent = JSON.parse(String(supplier.mock.calls[0][1]?.body));
          expect(row).toMatchObject({
            requested_strength: "low",
            output_token_limit: sent.max_tokens,
            reasoning_token_reserve: 0,
            max_attempts: 1,
            provider_attempt_count: 1,
            reasoning_tokens: 25,
          });
          expect(Number(row.per_attempt_tokens)).toBe(
            estimatePromptTokens(JSON.stringify(sent.messages)) + sent.max_tokens,
          );
          expect(supplier).toHaveBeenCalledTimes(1);
        });
      } finally {
        vi.unstubAllEnvs();
      }
    });
    it("preserves valid larger generated output in both the execution and Prompt version", async () => {
      vi.stubEnv("PROMPTMASTER_MODEL_MAX_OUTPUT_TOKENS", "auto");
      try {
        await accountContext.run(actor, async () => {
          const content = "x".repeat(200001);
          vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
              Response.json({
                model: "deepseek-flash",
                choices: [{ message: { content }, finish_reason: "stop" }],
                usage: { prompt_tokens: 20, completion_tokens: 30000, total_tokens: 30020 },
              }),
            ),
          );
          const result = await generateLivePrompt({
            goal: "Synthetic large output storage acceptance",
            taskType: "General",
            locale: "en",
            maxOutputTokens: 32768,
            strength: "low",
          });
          const row = (
            await getPool().query(
              "SELECT m.output_text,v.content FROM model_executions m JOIN prompt_versions v ON v.id=m.prompt_version_id WHERE m.id=$1",
              [result.executionId],
            )
          ).rows[0];
          expect(row.output_text).toBe(content);
          expect(row.content).toBe(content);
        });
      } finally {
        vi.unstubAllEnvs();
      }
    });
    it("honors direct report reasoning/output choices and rejects changing a recovered request", async () => {
      vi.stubEnv("PROMPTMASTER_MODEL_MAX_OUTPUT_TOKENS", "auto");
      try {
        await accountContext.run(actor, async () => {
          const text = "Write a launch plan. Include user acceptance checks.";
          const source = await createPrompt({
            title: "Synthetic selectable review",
            taskType: "Writing",
            content: text,
          });
          const supplier = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body));
            expect(body).toMatchObject({
              model: "deepseek-flash",
              max_tokens: 393216,
              thinking: { type: "enabled" },
              reasoning_effort: "low",
            });
            return Response.json({
              model: "deepseek-flash",
              choices: [
                {
                  message: { content: JSON.stringify(syntheticEvaluation(text)) },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 20,
                completion_tokens: 30,
                total_tokens: 50,
                completion_tokens_details: { reasoning_tokens: 25 },
              },
            });
          });
          vi.stubGlobal("fetch", supplier);
          const input = {
            purpose: "EVALUATION_REPORT" as const,
            promptId: source.promptId,
            versionId: source.versionId,
            locale: "en" as const,
            evaluationRequestKey: randomUUID(),
            strength: "low" as const,
            maxOutputTokens: 16384,
          };
          const result = await generateLiveSourceModel(input);
          expect(result.strength).toBe("low");
          const replay = await generateLiveSourceModel(input);
          expect(replay.executionId).toBe(result.executionId);
          expect(replay.usage).toEqual(result.usage);
          expect(replay.usage.reasoningTokens).toBe(25);
          await expect(
            generateLiveSourceModel({ ...input, strength: "high" }),
          ).rejects.toMatchObject({ code: "MODEL_EVALUATION_REQUEST_CONFLICT" });
          expect(supplier).toHaveBeenCalledTimes(1);
        });
      } finally {
        vi.unstubAllEnvs();
      }
    });
    it.each(["PROMPT_GENERATION", "OPTIMIZATION", "PLAYGROUND", "EVALUATION_REPORT"] as const)(
      "%s settles valid reasoning-only usage without saving an empty derivative or retrying",
      async (purpose) => {
        await accountContext.run(actor, async () => {
          const source = await createPrompt({
            title: "Reasoning-only baseline",
            taskType: "General",
            content: "Write a safe plan.",
          });
          const before = await getSnapshot();
          const supplier = vi.fn(async () =>
            Response.json({
              id: "synthetic-reasoning-only",
              model: "deepseek-flash",
              system_fingerprint: "synthetic-thinking-fingerprint",
              choices: [{ message: { content: "" }, finish_reason: "length" }],
              usage: {
                prompt_tokens: 20,
                completion_tokens: 128,
                total_tokens: 148,
                completion_tokens_details: { reasoning_tokens: 128 },
              },
            }),
          );
          vi.stubGlobal("fetch", supplier);
          const selection = { strength: "low" as const, maxOutputTokens: 128 };
          const sourceInput = {
            purpose: purpose === "PROMPT_GENERATION" ? ("PLAYGROUND" as const) : purpose,
            promptId: source.promptId,
            versionId: source.versionId,
            locale: "en" as const,
            evaluationRequestKey: purpose === "EVALUATION_REPORT" ? randomUUID() : undefined,
            playgroundRequestKey: purpose === "PLAYGROUND" ? randomUUID() : undefined,
            ...selection,
          };
          const request =
            purpose === "PROMPT_GENERATION"
              ? generateLivePrompt({
                  goal: "Create a safe planning prompt.",
                  taskType: "General",
                  locale: "en",
                  ...selection,
                })
              : generateLiveSourceModel(sourceInput);
          const error = await request.catch((failure: unknown) => failure);
          expect(error).toMatchObject({
            code: "DEEPSEEK_INVALID_RESPONSE",
            executionId: expect.any(String),
          });
          const failed = (
            await getPool().query("SELECT * FROM model_executions WHERE id=$1", [
              (error as { executionId: string }).executionId,
            ])
          ).rows[0];
          expect(failed).toMatchObject({
            status: "FAILED",
            output_text: "",
            total_tokens: 148,
            reasoning_tokens: 128,
            finish_reason: "length",
            system_fingerprint: "synthetic-thinking-fingerprint",
            provider_request_id: "synthetic-reasoning-only",
            quota_reservation_status: "SETTLED",
            provider_attempt_count: 1,
          });
          expect(Number(failed.reserved_total_tokens)).toBe(0);
          const quota = (
            await getPool().query(
              "SELECT settled_tokens,reserved_tokens FROM model_quota_usage_daily WHERE owner_user_id=$1",
              [actor.id],
            )
          ).rows[0];
          expect(Number(quota.settled_tokens)).toBe(148);
          expect(Number(quota.reserved_tokens)).toBe(0);
          const after = await getSnapshot();
          expect(after.prompts).toEqual(before.prompts);
          expect(after.versions).toEqual(before.versions);
          expect(after.optimizationRecords).toEqual(before.optimizationRecords);
          expect(after.playgroundRuns).toEqual(before.playgroundRuns);
          expect(after.liveAdvice.some((r) => r.executionId === failed.id)).toBe(false);
          if (purpose === "EVALUATION_REPORT" || purpose === "PLAYGROUND")
            await expect(generateLiveSourceModel(sourceInput)).rejects.toMatchObject({
              code:
                purpose === "PLAYGROUND"
                  ? "MODEL_PLAYGROUND_PREVIOUSLY_FAILED"
                  : "MODEL_EVALUATION_PREVIOUSLY_FAILED",
            });
          expect(supplier).toHaveBeenCalledTimes(1);
        });
      },
    );
    it("persists an evidence-checked direct report, recovers it without charging again, and isolates versions/owners", async () => {
      await accountContext.run(actor, async () => {
        const source = await createPrompt({
          title: "Synthetic review baseline",
          taskType: "Writing",
          content: "Write a launch plan. Include user acceptance checks.",
        });
        const before = await getSnapshot();
        const supplier = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
          expect(String(url)).toBe("https://api.deepseek.com/chat/completions");
          const body = JSON.parse(String(init?.body));
          expect(body.model).toBe("deepseek-flash");
          expect(body.max_tokens).toBe(modelOutputLimit());
          expect(body.messages[0].content).toContain("prompt-review-principles-v2");
          return Response.json({
            model: "deepseek-flash",
            choices: [
              {
                message: {
                  content: JSON.stringify(
                    syntheticEvaluation("Write a launch plan. Include user acceptance checks."),
                  ),
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 },
          });
        });
        vi.stubGlobal("fetch", supplier);
        const input = {
          purpose: "EVALUATION_REPORT" as const,
          promptId: source.promptId,
          versionId: source.versionId,
          locale: "en" as const,
          evaluationRequestKey: randomUUID(),
          modelKey: "tencent/Hy4-preview",
          strength: "default" as const,
        };
        const result = await generateLiveSourceModel(input);
        expect(result).toMatchObject({
          provider: "deepseek",
          requestedModel: "deepseek-flash",
          strength: "off",
          evaluation: { layer3: { status: "NOT_EXECUTED", executionId: null } },
        });
        const again = await generateLiveSourceModel(input);
        expect(again.executionId).toBe(result.executionId);
        expect(again.createdAt).toBe(result.createdAt);
        const reviewInput = {
          source: { promptId: source.promptId, versionId: source.versionId },
          taskType: "Writing" as const,
          locale: "en" as const,
          matchingMode: "MANUAL" as const,
          selectedVersionIds: [],
          evaluationHandoff: { reportId: result.executionId, indexes: [0] },
        };
        const reviewPlan = await createSkillPlan(reviewInput);
        expect(reviewPlan.analysis.reviewContext).toContain(
          result.evaluation!.suggestions[0].replacement,
        );
        await expect(
          createSkillPlan({
            ...reviewInput,
            evaluationHandoff: { reportId: "mex_missing", indexes: [0] },
          }),
        ).rejects.toMatchObject({ code: "EVALUATION_REPORT_NOT_FOUND" });
        const reviewOther = await createPrompt({
          title: "Other review source",
          taskType: "Writing",
          content: "Same text, different object",
        });
        await expect(
          createSkillPlan({
            ...reviewInput,
            source: { promptId: reviewOther.promptId, versionId: reviewOther.versionId },
          }),
        ).rejects.toMatchObject({ code: "EVALUATION_REPORT_NOT_FOUND" });
        expect(supplier).toHaveBeenCalledTimes(1);
        const saved = (
          await getPool().query("SELECT * FROM model_executions WHERE id=$1", [result.executionId])
        ).rows[0];
        expect(saved).toMatchObject({
          status: "SUCCEEDED",
          provider_attempt_count: 1,
          max_attempts: 1,
          quota_reservation_status: "SETTLED",
          total_tokens: 50,
        });
        expect(saved.evaluation_principles.layer1).toHaveLength(6);
        const after = await getSnapshot();
        expect(after.reports).toEqual(before.reports);
        expect(after.versions.filter((v) => v.promptId === source.promptId)).toEqual(
          before.versions,
        );
        expect(after.liveAdvice.find((r) => r.executionId === result.executionId)).toMatchObject({
          kind: "EVALUATION_REPORT",
          evaluation: result.evaluation,
        });
        await expect(
          getPool().query("UPDATE model_executions SET evaluation_report='{}'::jsonb WHERE id=$1", [
            result.executionId,
          ]),
        ).rejects.toMatchObject({ code: "23514" });
        const other = await createPrompt({
          title: "Same text different version",
          taskType: "Writing",
          content: "Write a launch plan. Include user acceptance checks.",
        });
        await expect(
          generateLiveSourceModel({
            ...input,
            promptId: other.promptId,
            versionId: other.versionId,
          }),
        ).rejects.toMatchObject({ code: "MODEL_EVALUATION_REQUEST_CONFLICT" });
        await accountContext.run(
          { id: `foreign-${randomUUID()}`, email: "foreign@example.test", role: "USER" },
          async () => {
            await expect(generateLiveSourceModel(input)).rejects.toMatchObject({
              code: "PROMPT_NOT_FOUND",
            });
          },
        );
        expect(supplier).toHaveBeenCalledTimes(1);
      });
    });

    it("invalid report settles known usage, retains raw output, and never replays a failed supplier call", async () => {
      await accountContext.run(actor, async () => {
        const source = await createPrompt({
          title: "Invalid report baseline",
          taskType: "General",
          content: "Write a safe plan.",
        });
        const raw = JSON.stringify({
          ...syntheticEvaluation("Write a safe plan.", "General"),
          score: 100,
        });
        const supplier = vi.fn(async () =>
          Response.json({
            model: "deepseek-flash",
            choices: [{ message: { content: raw }, finish_reason: "stop" }],
            usage: { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 },
          }),
        );
        vi.stubGlobal("fetch", supplier);
        const input = {
          purpose: "EVALUATION_REPORT" as const,
          promptId: source.promptId,
          versionId: source.versionId,
          locale: "zh-CN" as const,
          evaluationRequestKey: randomUUID(),
        };
        await expect(generateLiveSourceModel(input)).rejects.toMatchObject({
          code: "MODEL_EVALUATION_INVALID_REPORT",
        });
        const failed = (
          await getPool().query(
            "SELECT * FROM model_executions WHERE evaluation_request_key=$1 AND owner_user_id=$2",
            [input.evaluationRequestKey, actor.id],
          )
        ).rows[0];
        expect(failed).toMatchObject({
          status: "FAILED",
          output_text: raw,
          total_tokens: 25,
          evaluation_report: null,
          quota_reservation_status: "SETTLED",
          provider_attempt_count: 1,
        });
        expect((await getSnapshot()).liveAdvice.some((r) => r.executionId === failed.id)).toBe(
          false,
        );
        await expect(generateLiveSourceModel(input)).rejects.toMatchObject({
          code: "MODEL_EVALUATION_PREVIOUSLY_FAILED",
        });
        expect(supplier).toHaveBeenCalledTimes(1);
      });
    });

    it("concurrent recovery never dispatches twice; Layer 3 records only earlier real execution for this version", async () => {
      await accountContext.run(actor, async () => {
        const source = await createPrompt({
          title: "Concurrent report",
          taskType: "General",
          content: "Write a safe plan.",
        });
        setupSupplier(MODEL_CATALOG[0]);
        const playground = await generateLiveSourceModel({
          purpose: "PLAYGROUND",
          promptId: source.promptId,
          versionId: source.versionId,
          locale: "en",
          maxOutputTokens: 128,
        });
        let release!: () => void;
        let dispatched!: () => void;
        const ready = new Promise<void>((resolve) => {
          dispatched = resolve;
        });
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const supplier = vi.fn(async () => {
          dispatched();
          await held;
          return Response.json({
            model: "deepseek-flash",
            choices: [
              {
                message: {
                  content: JSON.stringify(syntheticEvaluation("Write a safe plan.", "General")),
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          });
        });
        vi.stubGlobal("fetch", supplier);
        const input = {
          purpose: "EVALUATION_REPORT" as const,
          promptId: source.promptId,
          versionId: source.versionId,
          locale: "en" as const,
          evaluationRequestKey: randomUUID(),
        };
        const running = generateLiveSourceModel(input);
        try {
          await ready;
          await expect(generateLiveSourceModel(input)).rejects.toMatchObject({
            code: "MODEL_EVALUATION_PENDING",
          });
        } finally {
          release();
        }
        const report = await running;
        expect(report.evaluation?.layer3).toEqual({
          status: "EXECUTED_UNGRADED",
          executionId: playground.executionId,
        });
        expect(report.evaluation?.principlesSnapshot?.selectionEvidence).toEqual([]);
        expect(supplier).toHaveBeenCalledTimes(1);
      });
    });

    it.each(MODEL_CATALOG)(
      "$key: optimize / playground / advice preserve exact versions and usage",
      async (m) =>
        accountContext.run(actor, async () => {
          const supplier = setupSupplier(m);
          const source = await createPrompt({
            title: "Synthetic baseline",
            taskType: "Coding",
            content: "Original fixed baseline, never overwritten",
          });
          const before = await getSnapshot();
          let optimizationId: string | undefined;
          let optimizedContent = "";
          for (const purpose of ["OPTIMIZATION", "PLAYGROUND", "EVALUATION_ADVICE"] as const) {
            const output = await generateLiveSourceModel({
              purpose,
              promptId: source.promptId,
              versionId: source.versionId,
              locale: "zh-CN",
              modelKey: m.key,
              strength: m.defaultStrength,
              maxOutputTokens: 128,
            });
            expect(output).toMatchObject({
              provider: m.provider,
              requestedModel: m.model,
              resolvedModel: m.model,
              strength: m.defaultStrength,
              versionId: source.versionId,
              usage: { promptTokens: 20, completionTokens: 30, totalTokens: 50 },
            });
            const e = (
              await getPool().query(
                "SELECT status,provider,provider_attempt_count,quota_reservation_status,total_tokens,output_token_limit FROM model_executions WHERE id=$1 AND owner_user_id=$2",
                [output.executionId, actor.id],
              )
            ).rows[0];
            expect(e).toMatchObject({
              status: "SUCCEEDED",
              provider: m.provider,
              provider_attempt_count: 1,
              quota_reservation_status: "SETTLED",
              total_tokens: 50,
              output_token_limit: modelOutputLimit(m.key),
            });
            if (purpose === "OPTIMIZATION") {
              optimizationId = output.optimizationId;
              optimizedContent = output.content;
            }
          }
          const snapshot = await getSnapshot();
          expect(snapshot.reports).toEqual(before.reports);
          expect(snapshot.versions.find((v) => v.id === source.versionId)?.content).toBe(
            "Original fixed baseline, never overwritten",
          );
          expect(snapshot.prompts.find((p) => p.id === source.promptId)?.currentVersionId).toBe(
            source.versionId,
          );
          expect(snapshot.playgroundRuns[0]).toMatchObject({
            versionId: source.versionId,
            source: liveSource(m.provider, "PLAYGROUND"),
            modelEvidence: { provider: m.provider, usage: { totalTokens: 50 } },
          });
          expect(snapshot.liveAdvice[0]).toMatchObject({
            provider: m.provider,
            model: m.model,
            versionId: source.versionId,
            strength: m.defaultStrength,
            usage: { totalTokens: 50 },
          });
          const applied = await createPromptVersion({
            promptId: source.promptId,
            content: optimizedContent,
            baseVersionId: source.versionId,
            source: liveSource(m.provider, "OPTIMIZATION"),
            optimizationId,
          });
          expect(applied?.versionId).not.toBe(source.versionId);
          expect(
            (await getSnapshot()).versions.find((v) => v.id === applied?.versionId)?.modelEvidence,
          ).toMatchObject({
            provider: m.provider,
            resolvedModel: m.model,
            usage: { totalTokens: 50 },
          });
          expect(supplier.fetchMock).toHaveBeenCalledTimes(3);
        }),
    );

    it.each(MODEL_CATALOG)(
      "$key: one actual synthetic Skill survives generation / optimize / replay / apply",
      async (m) =>
        accountContext.run(actor, async () => {
          const supplier = setupSupplier(m);
          const imported = await withTransaction((c) =>
            registerOfflineSkillInTransaction(
              c,
              syntheticSkill(
                undefined,
                "# Synthetic implementation method\nSYNTHETIC_SKILL_MARKER: state assumptions and acceptance checks. Never run scripts.",
              ),
              randomUUID(),
              actor.id,
              { actor, riskAccepted: true },
            ),
          );
          expect(imported.status).toBe("REGISTERED");
          const plan = await createSkillPlan({
            goal: "Plan task soft deletion and restoration",
            taskType: "Coding",
            locale: "en",
            matchingMode: "MANUAL",
            selectedVersionIds: [imported.versionId!],
          });
          expect(plan.selections).toHaveLength(1);
          const input = {
            planId: plan.id,
            purpose: "PROMPT_GENERATION" as const,
            modelKey: m.key,
            strength: m.defaultStrength,
            maxOutputTokens: 128,
          };
          const key = randomUUID();
          const generated = await runSkillPlan(input, key);
          expect(generated.status).toBe("SUCCEEDED");
          expect((await runSkillPlan(input, key)).result.executionId).toBe(
            generated.result.executionId,
          );
          const p = generated.result;
          const optimizationInput = {
            ...input,
            purpose: "OPTIMIZATION" as const,
            promptId: p.promptId,
            versionId: p.versionId,
          };
          const optimizationKey = randomUUID();
          const optimized = await runSkillPlan(optimizationInput, optimizationKey);
          expect(optimized.status).toBe("SUCCEEDED");
          expect((await runSkillPlan(optimizationInput, optimizationKey)).result.executionId).toBe(
            optimized.result.executionId,
          );
          expect(
            (await getSnapshot()).prompts.find((item) => item.id === p.promptId)?.currentVersionId,
          ).toBe(p.versionId);
          const saved = await createPromptVersion({
            promptId: p.promptId,
            baseVersionId: p.versionId,
            content: optimized.result.content,
            source: "SKILL_LIVE_OPTIMIZATION",
            optimizationId: optimized.result.optimizationId,
          });
          const snapshot = await getSnapshot();
          expect(snapshot.versions.find((v) => v.id === p.versionId)?.source).toBe(
            liveSource(m.provider, "GENERATION"),
          );
          expect(snapshot.versions.find((v) => v.id === saved?.versionId)).toMatchObject({
            source: "SKILL_LIVE_OPTIMIZATION",
            modelEvidence: {
              provider: m.provider,
              resolvedModel: m.model,
              strength: m.defaultStrength,
              usage: { totalTokens: 50 },
            },
          });
          const provenance = (
            await getPool().query(
              "SELECT prompt_version_id,skill_version_id,manifest_sha256 FROM prompt_skill_sources WHERE owner_user_id=$1 ORDER BY prompt_version_id",
              [actor.id],
            )
          ).rows;
          expect(provenance).toHaveLength(2);
          expect(
            provenance.every(
              (r) =>
                r.skill_version_id === imported.versionId &&
                r.manifest_sha256 === imported.manifestSha256,
            ),
          ).toBe(true);
          for (const call of supplier.calls) {
            expect(JSON.stringify(call.body)).toContain("SYNTHETIC_SKILL_MARKER");
            expect(JSON.stringify(call.body)).toContain("untrusted task data");
          }
          expect(snapshot.reports).toHaveLength(0);
          expect(supplier.fetchMock).toHaveBeenCalledTimes(2);
        }),
    );
  },
);
