import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPool, withTransaction } from "../db";
import { createAccountInTransaction } from "../accounts";
import { accountContext, type Actor } from "../identity-context";
import { PELICAN_PROMPT } from "@/lib/pelican-types";
import {
  createPelicanBatch,
  getPelicanAdminBatch,
  listPelicanPublic,
  publishPelicanBatch,
  rerunPelicanSample,
  withdrawPelicanBatch,
} from "./data";
import {
  runPelicanBatch,
  preparePelicanSample,
  cancelUndispatchedPelicanSamples,
  startPelicanBatch,
  stopPelicanBatch,
} from "./execution";
import { deleteFailedPelicanSample, deletePelicanBatch, getPelicanAdminData } from "./data";
import * as pelicanConfig from "./config";
import { readModelConfig } from "../model/model-config";
import {
  finalizeModelQuota,
  markModelAttempt,
  reserveModelQuotaInTransaction,
} from "../model/model-quota-repository";
import { pelicanHash, pelicanMessages } from "./policy";
import * as quotaRepository from "../model/model-quota-repository";
import { failModelExecution } from "../model/model-repository";
import { preparePelicanPreview } from "./renderer";

vi.mock("./renderer", () => ({
  PELICAN_ADAPTER_VERSION: "synthetic-test-only",
  preparePelicanPreview: vi.fn(async (raw: string, finish?: string) => ({
    html: raw,
    status: finish === "length" ? "TRUNCATED" : !raw.trim() ? "INVALID" : "READY",
    reason: null,
    thumbnail: Buffer.from("synthetic-renderer-thumbnail"),
    adapterVersion: "synthetic-test-only",
  })),
}));

describe.skipIf(process.env.PROMPTMASTER_PELICAN_DB_TEST !== "true")(
  "pelican explicit execution and ledger (isolated DB, mocked supplier)",
  () => {
    let admin: Actor;
    beforeEach(async () => {
      // The stop test asserts that a queued reservation is released without a
      // provider attempt; pin that scenario to one worker. Concurrent dispatch is
      // covered by the pure concurrency tests and the default production limit.
      vi.stubEnv("PROMPTMASTER_PELICAN_CONCURRENCY", "1");
      admin = await withTransaction((c) =>
        createAccountInTransaction(
          c,
          `pelican-exec-${randomUUID()}@example.test`,
          "scrypt$synthetic-unused",
          "ADMIN",
        ),
      );
      await getPool().query(
        "INSERT INTO model_quota_policies(owner_user_id,daily_token_limit,daily_cost_limit_usd,unlimited) VALUES($1,200000,1,true) ON CONFLICT(owner_user_id) DO UPDATE SET unlimited=true",
        [admin.id],
      );
      await getPool().query(
        "UPDATE billing_runtime_policy SET daily_usd=1000,period_usd=1000 WHERE id=true",
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          return Response.json({
            id: "synthetic-request",
            model: body.model,
            choices: [
              {
                message: { content: " \n<html><svg><circle r='8'/></svg></html>\n " },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 40, completion_tokens: 50, total_tokens: 90 },
          });
        }),
      );
    });
    afterAll(async () => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      if (process.env.PROMPTMASTER_PELICAN_DB_TEST === "true") await getPool().end();
    });
    const create = () =>
      createPelicanBatch({
        requestKey: randomUUID(),
        title: "Synthetic isolated test",
        selections: [{ modelKey: "deepseek-direct", strength: "off", maxOutputTokens: 512 }],
      });
    const run = <T>(fn: () => Promise<T>) => accountContext.run(admin, fn);
    it("acknowledges reserved background work, aborts dispatched work and releases only queued reservations", () =>
      run(async () => {
        let dispatched!: () => void;
        const active = new Promise<void>((resolve) => {
          dispatched = resolve;
        });
        vi.mocked(fetch).mockImplementation(
          async (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new Error("Stopped")), {
                once: true,
              });
              dispatched();
            }),
        );
        const batch = await createPelicanBatch({
          requestKey: randomUUID(),
          title: "Detached stop",
          selections: [
            { modelKey: "deepseek-direct", strength: "off", maxOutputTokens: 512 },
            { modelKey: "deepseek-ai/DeepSeek-V4-Pro", strength: "off", maxOutputTokens: 1024 },
          ],
        });
        const accepted = await startPelicanBatch(batch.id, batch.budgetFingerprint);
        expect(accepted.status).toBe("RUNNING");
        expect(accepted.samples.every((s) => s.callStatus === "PENDING")).toBe(true);
        await active;
        await stopPelicanBatch(batch.id);
        await vi.waitFor(async () => {
          const rows = (
            await getPool().query(
              "SELECT m.* FROM pelican_samples s JOIN model_executions m ON m.id=s.execution_id WHERE s.batch_id=$1 ORDER BY s.ordinal",
              [batch.id],
            )
          ).rows;
          expect(rows[0]).toMatchObject({
            status: "FAILED",
            provider_attempt_count: 1,
            quota_reservation_status: "HELD",
            error_code: "MODEL_REQUEST_CANCELLED",
          });
          expect(rows[1]).toMatchObject({
            status: "FAILED",
            provider_attempt_count: 0,
            quota_reservation_status: "RELEASED",
          });
        });
        expect(fetch).toHaveBeenCalledTimes(1);
        const failed = await getPelicanAdminBatch(batch.id);
        expect(failed.samples[0].canDelete).toBe(true);
        const before = (
          await getPool().query(
            "SELECT m.* FROM model_executions m JOIN pelican_samples s ON s.execution_id=m.id WHERE s.id=$1",
            [batch.samples[0].id],
          )
        ).rows[0];
        await deleteFailedPelicanSample(batch.id, batch.samples[0].id);
        expect((await getPelicanAdminBatch(batch.id)).samples).toHaveLength(1);
        const after = (
          await getPool().query(
            "SELECT m.* FROM model_executions m JOIN pelican_samples s ON s.execution_id=m.id WHERE s.id=$1",
            [batch.samples[0].id],
          )
        ).rows[0];
        expect(after).toEqual(before);
        expect(
          (
            await getPool().query("SELECT * FROM pelican_sample_deletions WHERE sample_id=$1", [
              batch.samples[0].id,
            ])
          ).rowCount,
        ).toBe(1);
        expect(
          (await getPelicanAdminData({ query: "Detached stop", status: "failed" })).batches.some(
            (b) => b.id === batch.id,
          ),
        ).toBe(true);
      }));
    it("freezes an automatic thinking artwork budget and dispatches its confirmed payload once", () =>
      run(async () => {
        vi.stubEnv("PROMPTMASTER_PELICAN_MAX_OUTPUT_TOKENS", "auto");
        try {
          const batch = await createPelicanBatch({
            requestKey: randomUUID(),
            title: "Synthetic auto reasoning",
            selections: [{ modelKey: "deepseek-direct", strength: "low" }],
          });
          expect(batch.samples[0]).toMatchObject({
            maxOutputTokens: 393216,
            strength: "low",
            reasoningTokenReserve: 0,
            timeoutMs: 0,
          });
          await runPelicanBatch(batch.id, batch.budgetFingerprint);
          const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
          expect(body).toMatchObject({
            max_tokens: 393216,
            thinking: { type: "enabled" },
            reasoning_effort: "low",
            messages: [{ role: "user", content: PELICAN_PROMPT }],
          });
          expect(fetch).toHaveBeenCalledTimes(1);
          const completed = await getPelicanAdminBatch(batch.id);
          expect(completed.samples[0].callStatus).toBe("SUCCEEDED");
          expect(completed.canPublish).toBe(true);
        } finally {
          vi.unstubAllEnvs();
        }
      }));
    it("reprepares an old adapter as an immutable revision without another model attempt", () =>
      run(async () => {
        const batch = await create();
        const id = batch.samples[0].id;
        await runPelicanBatch(batch.id, batch.budgetFingerprint);
        const revisionRenderer = vi.mocked(preparePelicanPreview);
        revisionRenderer.mockResolvedValueOnce({
          html: "<html>same saved output derivative</html>",
          status: "READY",
          reason: null,
          thumbnail: Buffer.from("synthetic-upgraded-thumbnail"),
          adapterVersion: "synthetic-new-adapter",
        });
        // A newer adapter version is represented by its exported version at dispatch.
        const rendererModule = await import("./renderer");
        const originalVersion = rendererModule.PELICAN_ADAPTER_VERSION;
        Object.defineProperty(rendererModule, "PELICAN_ADAPTER_VERSION", {
          value: "synthetic-new-adapter",
          configurable: true,
        });
        try {
          const before = (
            await getPool().query(
              "SELECT raw_output,adapter_version FROM pelican_samples WHERE id=$1",
              [id],
            )
          ).rows[0];
          await preparePelicanSample(id);
          await preparePelicanSample(id);
          expect(fetch).toHaveBeenCalledTimes(1);
          const after = (
            await getPool().query(
              "SELECT raw_output,adapter_version FROM pelican_samples WHERE id=$1",
              [id],
            )
          ).rows[0];
          expect(after).toEqual(before);
          const revisions = (
            await getPool().query("SELECT * FROM pelican_preview_revisions WHERE sample_id=$1", [
              id,
            ])
          ).rows;
          expect(revisions).toHaveLength(1);
          expect(revisions[0].adapter_version).toBe("synthetic-new-adapter");
          expect((await getPelicanAdminBatch(batch.id)).samples[0].previewStatus).toBe("READY");
          await expect(
            getPool().query(
              "UPDATE pelican_preview_revisions SET preview_reason='rewrite' WHERE sample_id=$1",
              [id],
            ),
          ).rejects.toMatchObject({ code: "23514" });
          await publishPelicanBatch(batch.id);
          await expect(
            getPool().query(
              "INSERT INTO pelican_preview_revisions(sample_id,adapter_version,raw_sha256,preview_status,created_by) SELECT id,'after-publication',encode(sha256(convert_to(raw_output,'UTF8')),'hex'),'INVALID',$2 FROM pelican_samples WHERE id=$1",
              [id, admin.id],
            ),
          ).rejects.toMatchObject({ code: "23514" });
          await withdrawPelicanBatch(batch.id, "Synthetic revision test completed");
        } finally {
          Object.defineProperty(rendererModule, "PELICAN_ADAPTER_VERSION", {
            value: originalVersion,
            configurable: true,
          });
        }
      }));
    const createTwo = () =>
      createPelicanBatch({
        requestKey: randomUUID(),
        title: "Synthetic interrupted batch",
        selections: [
          { modelKey: "deepseek-direct", strength: "off", maxOutputTokens: 512 },
          { modelKey: "deepseek-ai/DeepSeek-V4-Pro", strength: "off", maxOutputTokens: 512 },
        ],
      });
    async function createLegacyTwo() {
      const original = pelicanConfig.readPelicanModelConfig;
      const configSpy = vi
        .spyOn(pelicanConfig, "readPelicanModelConfig")
        .mockImplementation((env, selection) => {
          const value = original(env, selection);
          return value.mode === "LIVE"
            ? { ...value, timeoutMs: selection?.modelKey === "deepseek-direct" ? 30000 : 300000 }
            : value;
        });
      try {
        return await createTwo();
      } finally {
        configSpy.mockRestore();
      }
    }
    async function reserveInterruptedBatch(batchId: string) {
      return withTransaction(async (c) => {
        const samples = (
          await c.query("SELECT * FROM pelican_samples WHERE batch_id=$1 ORDER BY ordinal", [
            batchId,
          ])
        ).rows;
        const jobs = [];
        for (const sample of samples) {
          const config = readModelConfig(process.env, {
            modelKey: sample.model_key,
            strength: sample.config_snapshot.strength,
            maxOutputTokens: sample.config_snapshot.maxOutputTokens,
          });
          if (config.mode !== "LIVE") throw Error("Synthetic live config required");
          const executionId = `mex_${randomUUID()}`;
          await c.query(
            `INSERT INTO model_executions(id,owner_user_id,purpose,status,provider,requested_model,product_version,input_sha256) VALUES($1,$2,'PELICAN_TEST','PENDING',$3,$4,$5,$6)`,
            [
              executionId,
              admin.id,
              config.provider,
              config.model,
              config.productVersion,
              pelicanHash(pelicanMessages()),
            ],
          );
          await reserveModelQuotaInTransaction(
            c,
            {
              executionId,
              config: { ...config, maxRetries: 0 },
              serializedMessages: JSON.stringify(pelicanMessages()),
            },
            admin.id,
          );
          await c.query("UPDATE pelican_samples SET execution_id=$2 WHERE id=$1", [
            sample.id,
            executionId,
          ]);
          jobs.push({ sampleId: sample.id, executionId });
        }
        await c.query("UPDATE pelican_batches SET status='RUNNING' WHERE id=$1", [batchId]);
        return jobs;
      });
    }
    it("executes historical finite snapshots unchanged and prepares unlimited new reruns", () =>
      run(async () => {
        const batch = await createLegacyTwo();
        const before = (
          await getPool().query(
            "SELECT config_snapshot FROM pelican_samples WHERE batch_id=$1 ORDER BY ordinal",
            [batch.id],
          )
        ).rows;
        const done = await runPelicanBatch(batch.id, batch.budgetFingerprint);
        expect(done.samples.map((s) => s.callStatus)).toEqual(["SUCCEEDED", "SUCCEEDED"]);
        expect(done.samples.map((s) => s.timeoutMs)).toEqual([30000, 300000]);
        expect(
          (
            await getPool().query(
              "SELECT config_snapshot FROM pelican_samples WHERE batch_id=$1 ORDER BY ordinal",
              [batch.id],
            )
          ).rows,
        ).toEqual(before);
        const rerun = await rerunPelicanSample(batch.id, batch.samples[0].id, randomUUID());
        expect(rerun.samples.map((sample) => sample.timeoutMs)).toEqual([30000, 300000, 0]);
        const snapshots = (
          await getPool().query(
            "SELECT config_snapshot,request_payload FROM pelican_samples WHERE batch_id=$1 ORDER BY ordinal",
            [batch.id],
          )
        ).rows;
        expect(snapshots[0].config_snapshot).toEqual(before[0].config_snapshot);
        expect(snapshots[1].config_snapshot).toEqual(before[1].config_snapshot);
        expect(snapshots[2].config_snapshot).toEqual({
          ...before[0].config_snapshot,
          timeoutMs: 0,
          maxOutputTokens: 393216,
        });
        expect(snapshots[2].request_payload).toEqual({
          ...snapshots[0].request_payload,
          max_tokens: 393216,
        });
      }));
    it("settles SiliconFlow empty output with confirmed usage without retrying", () =>
      run(async () => {
        const batch = await createPelicanBatch({
          requestKey: randomUUID(),
          title: "Synthetic SF empty",
          selections: [
            { modelKey: "deepseek-ai/DeepSeek-V4-Pro", strength: "off", maxOutputTokens: 512 },
          ],
        });
        vi.mocked(fetch).mockResolvedValue(
          Response.json({
            model: "synthetic-sf",
            choices: [{ message: { content: "" }, finish_reason: "length" }],
            usage: { prompt_tokens: 40, completion_tokens: 50, total_tokens: 90 },
          }),
        );
        const done = await runPelicanBatch(batch.id, batch.budgetFingerprint);
        expect(done.samples[0]).toMatchObject({
          callStatus: "SUCCEEDED",
          previewStatus: "TRUNCATED",
        });
        expect(
          (
            await getPool().query(
              "SELECT m.status,m.quota_reservation_status,m.total_tokens FROM model_executions m JOIN pelican_samples s ON s.execution_id=m.id WHERE s.batch_id=$1",
              [batch.id],
            )
          ).rows[0],
        ).toMatchObject({
          status: "SUCCEEDED",
          quota_reservation_status: "SETTLED",
          total_tokens: 90,
        });
        expect(fetch).toHaveBeenCalledTimes(1);
      }));
    it("honors persisted stop intent when another route has no direct controller", () =>
      run(async () => {
        let dispatched!: () => void;
        const active = new Promise<void>((resolve) => {
          dispatched = resolve;
        });
        vi.mocked(fetch).mockImplementation(
          async (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new Error("Persisted stop")), {
                once: true,
              });
              dispatched();
            }),
        );
        const batch = await create();
        await startPelicanBatch(batch.id, batch.budgetFingerprint);
        await active;
        await getPool().query(
          "INSERT INTO pelican_sample_controls(sample_id,stop_requested_at,stop_requested_by) VALUES($1,clock_timestamp(),$2) ON CONFLICT(sample_id) DO UPDATE SET stop_requested_at=EXCLUDED.stop_requested_at,stop_requested_by=EXCLUDED.stop_requested_by",
          [batch.samples[0].id, admin.id],
        );
        await vi.waitFor(
          async () => {
            expect((await getPelicanAdminBatch(batch.id)).samples[0]).toMatchObject({
              callStatus: "UNKNOWN",
              errorCode: "MODEL_REQUEST_CANCELLED",
              stopRequested: true,
            });
          },
          { timeout: 3000 },
        );
        expect(fetch).toHaveBeenCalledTimes(1);
      }));
    it("surfaces an interrupted background heartbeat without redispatching or changing reservations", () =>
      run(async () => {
        const batch = await createTwo();
        const jobs = await reserveInterruptedBatch(batch.id);
        await markModelAttempt(jobs[0].executionId, admin.id);
        await getPool().query(
          "INSERT INTO pelican_batch_runs(batch_id,run_epoch,heartbeat_at) VALUES($1,'synthetic-previous-process',clock_timestamp()-interval '2 minutes')",
          [batch.id],
        );
        const before = (
          await getPool().query(
            "SELECT m.* FROM model_executions m JOIN pelican_samples s ON s.execution_id=m.id WHERE s.batch_id=$1 ORDER BY s.ordinal",
            [batch.id],
          )
        ).rows;
        const recovered = await getPelicanAdminBatch(batch.id);
        expect(
          recovered.samples.every(
            (s) => s.callStatus === "UNKNOWN" && s.errorCode === "PELICAN_RUN_INTERRUPTED",
          ),
        ).toBe(true);
        const listing = await getPelicanAdminData({ query: batch.title, status: "unknown" });
        expect(listing.batches.find((b) => b.id === batch.id)?.samples).toHaveLength(2);
        expect(
          (
            await getPool().query(
              "SELECT m.* FROM model_executions m JOIN pelican_samples s ON s.execution_id=m.id WHERE s.batch_id=$1 ORDER BY s.ordinal",
              [batch.id],
            )
          ).rows,
        ).toEqual(before);
        expect(fetch).not.toHaveBeenCalled();
      }));
    it("keeps dispatched costs held or settled during a response and stop race", () =>
      run(async () => {
        let dispatch!: () => void;
        let respond!: () => void;
        const active = new Promise<void>((resolve) => {
          dispatch = resolve;
        });
        vi.mocked(fetch).mockImplementation(
          async (_url, init) =>
            new Promise<Response>((resolve, reject) => {
              respond = () =>
                resolve(
                  Response.json({
                    model: "synthetic",
                    choices: [
                      { message: { content: "<html><svg/></html>" }, finish_reason: "stop" },
                    ],
                    usage: { prompt_tokens: 40, completion_tokens: 50, total_tokens: 90 },
                  }),
                );
              init?.signal?.addEventListener("abort", () => reject(new Error("Stopped")), {
                once: true,
              });
              dispatch();
            }),
        );
        const batch = await create();
        await startPelicanBatch(batch.id, batch.budgetFingerprint);
        await active;
        const stop = stopPelicanBatch(batch.id, batch.samples[0].id);
        respond();
        await stop;
        await vi.waitFor(async () => {
          const execution = (
            await getPool().query(
              "SELECT m.* FROM model_executions m JOIN pelican_samples s ON s.execution_id=m.id WHERE s.batch_id=$1",
              [batch.id],
            )
          ).rows[0];
          expect(execution.status).not.toBe("PENDING");
          expect(execution.provider_attempt_count).toBe(1);
          expect(["HELD", "SETTLED"]).toContain(execution.quota_reservation_status);
        });
        expect(fetch).toHaveBeenCalledTimes(1);
      }));
    it("protects pending and succeeded results and restricts stop to the owning administrator", () =>
      run(async () => {
        const batch = await create();
        await expect(
          deleteFailedPelicanSample(batch.id, batch.samples[0].id),
        ).rejects.toMatchObject({ status: 409 });
        const other = await withTransaction((c) =>
          createAccountInTransaction(
            c,
            `pelican-stop-other-${randomUUID()}@example.test`,
            "scrypt$synthetic-unused",
            "ADMIN",
          ),
        );
        await expect(
          accountContext.run(other, () => stopPelicanBatch(batch.id)),
        ).rejects.toMatchObject({ status: 404 });
        await runPelicanBatch(batch.id, batch.budgetFingerprint);
        await expect(
          deleteFailedPelicanSample(batch.id, batch.samples[0].id),
        ).rejects.toMatchObject({ status: 409 });
        expect(fetch).toHaveBeenCalledTimes(1);
      }));
    it("allows preceding same-reservation jobs to finish before classifying a queued dispatch as overdue", () =>
      run(async () => {
        const batch = await createLegacyTwo();
        const jobs = await reserveInterruptedBatch(batch.id);
        await markModelAttempt(jobs[1].executionId, admin.id);
        const initial = await getPelicanAdminBatch(batch.id);
        const created = (
          await getPool().query("SELECT created_at FROM model_executions WHERE id=$1", [
            jobs[1].executionId,
          ])
        ).rows[0].created_at;
        const ownDeadline = new Date(created).getTime() + initial.samples[1].timeoutMs + 60000;
        const clock = vi.spyOn(Date, "now").mockReturnValue(ownDeadline + 1);
        try {
          expect((await getPelicanAdminBatch(batch.id)).samples[1].callStatus).toBe("PENDING");
          clock.mockReturnValue(ownDeadline + initial.samples[0].timeoutMs + 30000 + 1);
          expect((await getPelicanAdminBatch(batch.id)).samples[1].callStatus).toBe("UNKNOWN");
          expect(fetch).not.toHaveBeenCalled();
        } finally {
          clock.mockRestore();
        }
      }));
    it("shows an overdue dispatched interruption as unknown without releasing or rewriting its ledger", () =>
      run(async () => {
        const batch = await createLegacyTwo();
        const jobs = await reserveInterruptedBatch(batch.id);
        await markModelAttempt(jobs[0].executionId, admin.id);
        expect((await getPelicanAdminBatch(batch.id)).samples[0].callStatus).toBe("PENDING");
        const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 700000);
        try {
          const recovered = await getPelicanAdminBatch(batch.id);
          expect(recovered.samples[0].callStatus).toBe("UNKNOWN");
          expect(recovered.samples[1].callStatus).toBe("PENDING");
          expect(recovered.canRun).toBe(false);
          expect(recovered.canPublish).toBe(false);
          expect(
            (
              await getPool().query(
                "SELECT status,provider_attempt_count,quota_reservation_status FROM model_executions WHERE id=$1",
                [jobs[0].executionId],
              )
            ).rows[0],
          ).toMatchObject({
            status: "PENDING",
            provider_attempt_count: 1,
            quota_reservation_status: "RESERVED",
          });
          expect(fetch).not.toHaveBeenCalled();
        } finally {
          clock.mockRestore();
        }
      }));
    it("continues remaining reserved jobs after one preview read fails and recovers that preview without another model call", () =>
      run(async () => {
        const batch = await createTwo();
        expect(batch.canRun).toBe(true);
        const pool = getPool(),
          originalQuery = pool.query;
        let rejected = false;
        const querySpy = vi.spyOn(pool, "query").mockImplementation((...args) => {
          if (
            !rejected &&
            typeof args[0] === "string" &&
            args[0].includes("SELECT s.*,m.status AS execution_status,m.finish_reason")
          ) {
            rejected = true;
            return Promise.reject(Error("Synthetic one-time preview read failure"));
          }
          return Reflect.apply(originalQuery, pool, args);
        });
        try {
          const done = await runPelicanBatch(batch.id, batch.budgetFingerprint);
          expect(rejected).toBe(true);
          expect(done.samples.map((s) => s.callStatus)).toEqual(["SUCCEEDED", "SUCCEEDED"]);
          expect(done.samples.map((s) => s.previewStatus)).toEqual(["PENDING", "READY"]);
          expect(done.status).toBe("COMPLETE");
          expect(done.canPublish).toBe(false);
          expect(fetch).toHaveBeenCalledTimes(2);
        } finally {
          querySpy.mockRestore();
        }
        await preparePelicanSample(batch.samples[0].id);
        const recovered = await getPelicanAdminBatch(batch.id);
        expect(recovered.status).toBe("COMPLETE");
        expect(recovered.canPublish).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(2);
      }));
    it("rolls back every reservation when the selected pricing snapshot changes after budget confirmation", () =>
      run(async () => {
        const batch = await create();
        const originalReserve = quotaRepository.reserveModelQuotaInTransaction;
        let replaced = false;
        const reserveSpy = vi
          .spyOn(quotaRepository, "reserveModelQuotaInTransaction")
          .mockImplementation(async (c, input, owner) => {
            if (!replaced) {
              replaced = true;
              await c.query(
                `INSERT INTO model_pricing_snapshots(id,provider,requested_model,product_version,pricing_window,input_cache_hit_usd_per_million,input_cache_miss_usd_per_million,output_usd_per_million,source_url,effective_at,valid_until)
              SELECT $1,provider,requested_model,product_version,pricing_window,input_cache_hit_usd_per_million,input_cache_miss_usd_per_million,output_usd_per_million,source_url,now(),valid_until FROM model_pricing_snapshots WHERE provider=$2 AND requested_model=$3 AND product_version=$4 AND pricing_window='PEAK' AND valid_until>now() ORDER BY effective_at DESC LIMIT 1`,
                [
                  `synthetic-repriced-${randomUUID()}`,
                  input.config.provider,
                  input.config.model,
                  input.config.productVersion,
                ],
              );
            }
            return originalReserve(c, input, owner);
          });
        try {
          await expect(runPelicanBatch(batch.id, batch.budgetFingerprint)).rejects.toMatchObject({
            code: "PELICAN_BUDGET_CHANGED",
          });
          expect(replaced).toBe(true);
          expect((await getPelicanAdminBatch(batch.id)).samples[0].callStatus).toBe("QUEUED");
          expect(
            (
              await getPool().query(
                "SELECT count(*)::int count FROM model_executions WHERE owner_user_id=$1",
                [admin.id],
              )
            ).rows[0].count,
          ).toBe(0);
          expect(fetch).not.toHaveBeenCalled();
        } finally {
          reserveSpy.mockRestore();
        }
      }));
    it("cancels only zero-attempt reserved samples, releases their quota and prevents a late dispatcher from fetching", () =>
      run(async () => {
        const batch = await createTwo();
        const jobs = await reserveInterruptedBatch(batch.id);
        await markModelAttempt(jobs[0].executionId, admin.id);
        await failModelExecution(jobs[0].executionId, {
          code: "SYNTHETIC_RESULT_UNKNOWN",
          message: "Synthetic interrupted supplier result",
          latencyMs: 1,
        });
        const activeBefore = (
          await getPool().query("SELECT * FROM model_executions WHERE id=$1", [jobs[0].executionId])
        ).rows[0];
        const before = (
          await getPool().query(
            "SELECT reserved_tokens,reserved_cost_usd FROM model_quota_usage_daily WHERE owner_user_id=$1",
            [admin.id],
          )
        ).rows[0];
        const pending = (
          await getPool().query("SELECT * FROM model_executions WHERE id=$1", [jobs[1].executionId])
        ).rows[0];
        await expect(
          accountContext.run(null, () => cancelUndispatchedPelicanSamples(batch.id)),
        ).rejects.toMatchObject({ status: 401 });
        const done = await cancelUndispatchedPelicanSamples(batch.id);
        const cancelled = (
          await getPool().query("SELECT * FROM model_executions WHERE id=$1", [jobs[1].executionId])
        ).rows[0];
        expect(cancelled).toMatchObject({
          status: "FAILED",
          provider_attempt_count: 0,
          quota_reservation_status: "RELEASED",
          reconciliation_status: "NOT_REQUIRED",
          error_code: "ADMIN_CANCELLED_UNDISPATCHED",
          latency_ms: 0,
          output_text: null,
        });
        const activeAfter = (
          await getPool().query("SELECT * FROM model_executions WHERE id=$1", [jobs[0].executionId])
        ).rows[0];
        expect(activeAfter).toEqual(activeBefore);
        expect(done.samples[0].callStatus).toBe("UNKNOWN");
        expect(done.samples[1]).toMatchObject({ callStatus: "FAILED", previewStatus: "INVALID" });
        expect(done.status).toBe("COMPLETE");
        const after = (
          await getPool().query(
            "SELECT reserved_tokens,reserved_cost_usd FROM model_quota_usage_daily WHERE owner_user_id=$1",
            [admin.id],
          )
        ).rows[0];
        expect(Number(after.reserved_tokens)).toBe(
          Number(before.reserved_tokens) - Number(pending.reserved_total_tokens),
        );
        expect(Number(after.reserved_cost_usd)).toBeCloseTo(
          Number(before.reserved_cost_usd) - Number(pending.estimated_cost_usd),
          8,
        );
        await expect(markModelAttempt(jobs[1].executionId, admin.id)).rejects.toThrow();
        await cancelUndispatchedPelicanSamples(batch.id);
        expect(
          (
            await getPool().query("SELECT * FROM model_executions WHERE id=$1", [
              jobs[1].executionId,
            ])
          ).rows[0],
        ).toEqual(cancelled);
        expect(fetch).not.toHaveBeenCalled();
      }));
    it("completes an entirely undispatched interrupted batch after idempotent cancellation by another active administrator", () =>
      run(async () => {
        const batch = await createTwo();
        const jobs = await reserveInterruptedBatch(batch.id);
        const governor = await withTransaction((c) =>
          createAccountInTransaction(
            c,
            `pelican-governor-${randomUUID()}@example.test`,
            "scrypt$synthetic-unused",
            "ADMIN",
          ),
        );
        const done = await accountContext.run(governor, () =>
          cancelUndispatchedPelicanSamples(batch.id),
        );
        expect(done.status).toBe("COMPLETE");
        expect(done.canPublish).toBe(true);
        expect(
          done.samples.every((s) => s.callStatus === "FAILED" && s.previewStatus === "INVALID"),
        ).toBe(true);
        expect(
          (
            await getPool().query(
              "SELECT reserved_tokens,reserved_cost_usd FROM model_quota_usage_daily WHERE owner_user_id=$1",
              [admin.id],
            )
          ).rows[0],
        ).toMatchObject({ reserved_tokens: 0, reserved_cost_usd: "0.00000000" });
        await cancelUndispatchedPelicanSamples(batch.id);
        for (const job of jobs)
          await expect(markModelAttempt(job.executionId, admin.id)).rejects.toThrow();
        expect(fetch).not.toHaveBeenCalled();
      }));
    it("sends only the exact question once and retains untouched raw output, parameters, costs and public boundaries", () =>
      run(async () => {
        const batch = await create();
        expect(fetch).not.toHaveBeenCalled();
        await expect(publishPelicanBatch(batch.id)).rejects.toThrow();
        const outcomes = await Promise.allSettled([
          runPelicanBatch(batch.id, batch.budgetFingerprint),
          runPelicanBatch(batch.id, batch.budgetFingerprint),
        ]);
        expect(outcomes.some((r) => r.status === "fulfilled")).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(1);
        const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
        expect(body.messages).toEqual([{ role: "user", content: PELICAN_PROMPT }]);
        const rows = (
          await getPool().query(
            "SELECT s.*,m.purpose,m.output_text,m.total_tokens,m.quota_reservation_status FROM pelican_samples s JOIN model_executions m ON m.id=s.execution_id WHERE s.batch_id=$1",
            [batch.id],
          )
        ).rows;
        expect(rows[0]).toMatchObject({
          raw_output: " \n<html><svg><circle r='8'/></svg></html>\n ",
          output_text: " \n<html><svg><circle r='8'/></svg></html>\n ",
          purpose: "PELICAN_TEST",
          total_tokens: 90,
          quota_reservation_status: "SETTLED",
        });
        expect(rows[0].request_payload).toEqual(body);
        await expect(
          getPool().query("UPDATE pelican_samples SET raw_output='changed' WHERE id=$1", [
            rows[0].id,
          ]),
        ).rejects.toThrow();
        await expect(
          getPool().query("UPDATE model_executions SET output_text='changed' WHERE id=$1", [
            rows[0].execution_id,
          ]),
        ).rejects.toThrow();
        for (const mutation of [
          "id='changed-id'",
          "created_at=created_at+interval '1 second'",
          "input_sha256=repeat('b',64)",
          "dispatched_messages_sha256=repeat('b',64)",
          "request_identity_sha256=repeat('b',64)",
          "system_fingerprint='changed'",
          "prompt_cache_hit_tokens=1",
          "prompt_cache_miss_tokens=1",
          "reasoning_tokens=1",
        ])
          await expect(
            getPool().query(`UPDATE model_executions SET ${mutation} WHERE id=$1`, [
              rows[0].execution_id,
            ]),
          ).rejects.toMatchObject({ code: "23514" });
        for (const mutation of [
          "id='changed-sample'",
          "created_at=created_at+interval '1 second'",
          "response_model='changed'",
          "response_finish_reason='changed'",
        ])
          await expect(
            getPool().query(`UPDATE pelican_samples SET ${mutation} WHERE id=$1`, [rows[0].id]),
          ).rejects.toMatchObject({ code: "23514" });
        await expect(
          getPool().query("DELETE FROM model_executions WHERE id=$1", [rows[0].execution_id]),
        ).rejects.toMatchObject({ code: "23514" });
        const done = await getPelicanAdminBatch(batch.id);
        expect(done.canPublish).toBe(true);
        await publishPelicanBatch(batch.id);
        const published = await accountContext.run(null, () =>
          listPelicanPublic(new URLSearchParams({ batchId: batch.id })),
        );
        expect(published.batches[0].samples[0]).toMatchObject({
          callStatus: "SUCCEEDED",
          previewStatus: "READY",
          maxOutputTokens: 393216,
        });
        for (const secret of [
          "raw_output",
          "rawOutput",
          "request_payload",
          "apiKey",
          "owner_user_id",
          "synthetic-request",
          "synthetic-renderer-thumbnail",
        ])
          expect(JSON.stringify(published)).not.toContain(secret);
        await withdrawPelicanBatch(batch.id, "Synthetic withdrawal");
        expect(
          (
            await accountContext.run(null, () =>
              listPelicanPublic(new URLSearchParams({ batchId: batch.id })),
            )
          ).batches,
        ).toHaveLength(0);
        expect(fetch).toHaveBeenCalledTimes(1);
      }));
    it("blocks stale budget and inadequate quota before supplier dispatch", () =>
      run(async () => {
        const batch = await create();
        await expect(runPelicanBatch(batch.id, "stale-budget")).rejects.toThrow();
        await getPool().query(
          "INSERT INTO model_quota_policies(owner_user_id,daily_token_limit,daily_cost_limit_usd) VALUES($1,1,0) ON CONFLICT(owner_user_id) DO UPDATE SET daily_token_limit=1,daily_cost_limit_usd=0,unlimited=false",
          [admin.id],
        );
        await expect(runPelicanBatch(batch.id, batch.budgetFingerprint)).rejects.toThrow();
        expect(fetch).not.toHaveBeenCalled();
      }));
    it("never replays an uncertain dispatch, cannot publish it, and keeps its held cost", () =>
      run(async () => {
        vi.mocked(fetch).mockRejectedValue(new TypeError("synthetic lost response"));
        const batch = await create();
        await runPelicanBatch(batch.id, batch.budgetFingerprint);
        const uncertain = await getPelicanAdminBatch(batch.id);
        expect(uncertain.samples[0].callStatus).toBe("UNKNOWN");
        expect(uncertain.canPublish).toBe(false);
        await expect(runPelicanBatch(batch.id, uncertain.budgetFingerprint)).rejects.toThrow();
        await expect(publishPelicanBatch(batch.id)).rejects.toThrow();
        await expect(
          rerunPelicanSample(batch.id, uncertain.samples[0].id, randomUUID()),
        ).rejects.toThrow();
        expect(fetch).toHaveBeenCalledTimes(1);
      }));
    it("keeps truncation separate from call success; reruns append a linked sample and do not hide the original", () =>
      run(async () => {
        vi.mocked(fetch).mockImplementation(async () =>
          Response.json({
            model: "deepseek-flash",
            choices: [{ message: { content: "<html><svg>" }, finish_reason: "length" }],
            usage: { prompt_tokens: 40, completion_tokens: 50, total_tokens: 90 },
          }),
        );
        const batch = await create();
        await runPelicanBatch(batch.id, batch.budgetFingerprint);
        const done = await getPelicanAdminBatch(batch.id);
        expect(done.samples[0]).toMatchObject({
          callStatus: "SUCCEEDED",
          previewStatus: "TRUNCATED",
        });
        const key = randomUUID();
        await rerunPelicanSample(batch.id, done.samples[0].id, key);
        const rerun = await rerunPelicanSample(batch.id, done.samples[0].id, key);
        expect(rerun.samples).toHaveLength(2);
        expect(rerun.samples[1].rerunOf).toBe(done.samples[0].id);
        expect(fetch).toHaveBeenCalledTimes(1);
        await runPelicanBatch(batch.id, rerun.budgetFingerprint);
        const second = await getPelicanAdminBatch(batch.id);
        const chained = await rerunPelicanSample(batch.id, second.samples[1].id, randomUUID());
        expect(chained.samples).toHaveLength(3);
        expect(chained.samples[2].rerunOf).toBe(second.samples[1].id);
        expect(chained.samples[0].id).toBe(done.samples[0].id);
        expect(fetch).toHaveBeenCalledTimes(2);
      }));
    it("recovers saved successful output and pending preview after interruption without fetching another model result", () =>
      run(async () => {
        const batch = await create();
        const sampleId = batch.samples[0].id;
        const config = readModelConfig(process.env, {
          modelKey: "deepseek-direct",
          strength: "off",
          maxOutputTokens: 512,
        });
        if (config.mode !== "LIVE") throw Error("Synthetic live config required");
        const executionId = `mex_${randomUUID()}`;
        await withTransaction(async (c) => {
          await c.query(
            `INSERT INTO model_executions(id,owner_user_id,purpose,status,provider,requested_model,product_version,input_sha256) VALUES($1,$2,'PELICAN_TEST','PENDING',$3,$4,$5,$6)`,
            [
              executionId,
              admin.id,
              config.provider,
              config.model,
              config.productVersion,
              pelicanHash(pelicanMessages()),
            ],
          );
          await reserveModelQuotaInTransaction(
            c,
            {
              executionId,
              config: { ...config, maxRetries: 0 },
              serializedMessages: JSON.stringify(pelicanMessages()),
            },
            admin.id,
          );
          await c.query(
            `UPDATE model_executions SET status='SUCCEEDED',provider_attempt_count=1,output_text=$2,resolved_model=$3,prompt_tokens=40,completion_tokens=50,total_tokens=90,finish_reason='stop',latency_ms=10,completed_at=now() WHERE id=$1`,
            [executionId, "<html><svg><circle/></svg></html>", config.model],
          );
          await c.query(
            `UPDATE pelican_samples SET execution_id=$2,raw_output=$3,response_model=$4,response_finish_reason='stop' WHERE id=$1`,
            [sampleId, executionId, "<html><svg><circle/></svg></html>", config.model],
          );
          await finalizeModelQuota(c, executionId, admin.id, {
            promptTokens: 40,
            completionTokens: 50,
            totalTokens: 90,
          });
          await c.query("UPDATE pelican_batches SET status='RUNNING' WHERE id=$1", [batch.id]);
        });
        expect((await getPelicanAdminBatch(batch.id)).samples[0].previewStatus).toBe("PENDING");
        await preparePelicanSample(sampleId);
        await preparePelicanSample(sampleId);
        const recovered = await getPelicanAdminBatch(batch.id);
        expect(recovered.status).toBe("COMPLETE");
        expect(recovered.samples[0]).toMatchObject({
          callStatus: "SUCCEEDED",
          previewStatus: "READY",
        });
        expect(recovered.canPublish).toBe(true);
        expect(fetch).not.toHaveBeenCalled();
      }));
    it("preserves an absent provider response model as unknown rather than fabricating requested identity", () =>
      run(async () => {
        vi.mocked(fetch).mockResolvedValue(
          Response.json({
            choices: [{ message: { content: "<html><svg/></html>" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 40, completion_tokens: 50, total_tokens: 90 },
          }),
        );
        const batch = await create();
        const done = await runPelicanBatch(batch.id, batch.budgetFingerprint);
        expect(done.samples[0]).toMatchObject({
          callStatus: "SUCCEEDED",
          requestedModel: "deepseek-flash",
          resolvedModel: null,
        });
        const row = (
          await getPool().query(
            "SELECT s.response_model,m.resolved_model FROM pelican_samples s JOIN model_executions m ON m.id=s.execution_id WHERE s.id=$1",
            [done.samples[0].id],
          )
        ).rows[0];
        expect(row).toEqual({ response_model: null, resolved_model: null });
        expect(fetch).toHaveBeenCalledTimes(1);
      }));
    it("records provider rate limiting once and never automatically retries or releases unverified charges", () =>
      run(async () => {
        vi.mocked(fetch).mockResolvedValue(
          Response.json({ error: { message: "Synthetic rate limit" } }, { status: 429 }),
        );
        const batch = await create();
        const done = await runPelicanBatch(batch.id, batch.budgetFingerprint);
        expect(fetch).toHaveBeenCalledTimes(1);
        const row = (
          await getPool().query(
            "SELECT m.* FROM pelican_samples s JOIN model_executions m ON m.id=s.execution_id WHERE s.id=$1",
            [done.samples[0].id],
          )
        ).rows[0];
        expect(row).toMatchObject({
          status: "FAILED",
          error_code: "DEEPSEEK_RATE_LIMITED",
          provider_attempt_count: 1,
          quota_reservation_status: "HELD",
          reconciliation_status: "REQUIRED",
          total_tokens: null,
        });
        expect(done.canPublish).toBe(false);
        await expect(runPelicanBatch(batch.id, done.budgetFingerprint)).rejects.toThrow();
        expect(fetch).toHaveBeenCalledTimes(1);
        await expect(
          getPool().query("UPDATE model_executions SET error_code='changed' WHERE id=$1", [row.id]),
        ).rejects.toMatchObject({ code: "23514" });
      }));
    it.each([
      { raw: "", finish: "length", preview: "TRUNCATED" },
      { raw: " \n ", finish: "stop", preview: "INVALID" },
    ])(
      "preserves empty $finish output with known usage and truthful preview status",
      ({ raw, finish, preview }) =>
        run(async () => {
          vi.mocked(fetch).mockResolvedValue(
            Response.json({
              id: "synthetic-empty",
              model: "deepseek-flash",
              choices: [{ message: { content: raw }, finish_reason: finish }],
              usage: { prompt_tokens: 40, completion_tokens: 50, total_tokens: 90 },
            }),
          );
          const batch = await create();
          const done = await runPelicanBatch(batch.id, batch.budgetFingerprint);
          const row = (
            await getPool().query(
              "SELECT s.raw_output,s.response_finish_reason,m.status,m.output_text,m.total_tokens,m.quota_reservation_status,m.finish_reason,m.reconciliation_status FROM pelican_samples s JOIN model_executions m ON m.id=s.execution_id WHERE s.id=$1",
              [done.samples[0].id],
            )
          ).rows[0];
          expect(row).toMatchObject({
            raw_output: raw,
            output_text: raw,
            status: "SUCCEEDED",
            total_tokens: 90,
            quota_reservation_status: "SETTLED",
            finish_reason: finish,
            response_finish_reason: finish,
          });
          expect(done.samples[0]).toMatchObject({
            callStatus: "SUCCEEDED",
            previewStatus: preview,
          });
          expect(done.canPublish).toBe(true);
          expect(fetch).toHaveBeenCalledTimes(1);
        }),
    );
    it("preparing or reading a saved preview never calls the model", () =>
      run(async () => {
        const batch = await create();
        await expect(preparePelicanSample(batch.samples[0].id)).rejects.toThrow();
        expect(fetch).not.toHaveBeenCalled();
      }));
    it("retains original output beyond the preview's previous character limit without losing known usage", () =>
      run(async () => {
        const raw = "<html><svg/></html><!--" + "x".repeat(210000) + "-->";
        vi.mocked(fetch).mockImplementation(async () =>
          Response.json({
            model: "deepseek-flash",
            choices: [{ message: { content: raw }, finish_reason: "stop" }],
            usage: { prompt_tokens: 40, completion_tokens: 50, total_tokens: 90 },
          }),
        );
        const batch = await create();
        await runPelicanBatch(batch.id, batch.budgetFingerprint);
        const row = (
          await getPool().query(
            "SELECT s.raw_output,s.preview_html,m.status,m.total_tokens,m.quota_reservation_status FROM pelican_samples s JOIN model_executions m ON m.id=s.execution_id WHERE s.batch_id=$1",
            [batch.id],
          )
        ).rows[0];
        expect(row.raw_output === raw).toBe(true);
        expect(row.preview_html === raw).toBe(true);
        const ordinaryOutput = await getPool().query(
          "INSERT INTO model_executions(id,owner_user_id,purpose,status,provider,requested_model,product_version,input_sha256,output_text) VALUES($1,$2,'PLAYGROUND','PENDING','deepseek','deepseek-flash','Synthetic-only',$3,$4) RETURNING output_text",
          [`mex_${randomUUID()}`, admin.id, "a".repeat(64), raw],
        );
        expect(ordinaryOutput.rows[0].output_text).toBe(raw);
        expect(row).toMatchObject({
          status: "SUCCEEDED",
          total_tokens: 90,
          quota_reservation_status: "SETTLED",
        });
        expect(fetch).toHaveBeenCalledTimes(1);
      }));
    it("finalizes an orphaned dispatched run when stopped and completes the batch", () =>
      run(async () => {
        const batch = await createTwo();
        const jobs = await reserveInterruptedBatch(batch.id);
        await markModelAttempt(jobs[0].executionId, admin.id);
        const stopped = await stopPelicanBatch(batch.id);
        expect(stopped.status).toBe("COMPLETE");
        expect(stopped.samples[0]).toMatchObject({
          callStatus: "UNKNOWN",
          canStop: false,
          canDelete: true,
          stopRequested: true,
        });
        const rows = (
          await getPool().query(
            "SELECT m.status,m.error_code,m.quota_reservation_status,m.reconciliation_status,m.provider_attempt_count FROM pelican_samples s JOIN model_executions m ON m.id=s.execution_id WHERE s.batch_id=$1 ORDER BY s.ordinal",
            [batch.id],
          )
        ).rows;
        expect(rows[0]).toMatchObject({
          status: "FAILED",
          error_code: "PELICAN_RUN_INTERRUPTED",
          quota_reservation_status: "HELD",
          reconciliation_status: "REQUIRED",
          provider_attempt_count: 1,
        });
        expect(rows[1]).toMatchObject({
          status: "FAILED",
          error_code: "ADMIN_CANCELLED_UNDISPATCHED",
          quota_reservation_status: "RELEASED",
          reconciliation_status: "NOT_REQUIRED",
          provider_attempt_count: 0,
        });
        expect(fetch).not.toHaveBeenCalled();
        const repeated = await stopPelicanBatch(batch.id);
        expect(repeated.status).toBe("COMPLETE");
        expect(repeated.samples[0].callStatus).toBe("UNKNOWN");
      }));
    it("completes a stale RUNNING batch from terminal records when management state is read", () =>
      run(async () => {
        const batch = await createTwo();
        const jobs = await reserveInterruptedBatch(batch.id);
        await withTransaction(async (c) => {
          for (const job of jobs) {
            await c.query(
              "UPDATE model_executions SET status='FAILED',error_code='SYNTHETIC_TERMINAL',error_message='Synthetic terminal failure',completed_at=clock_timestamp() WHERE id=$1",
              [job.executionId],
            );
            await finalizeModelQuota(c, job.executionId, admin.id);
          }
        });
        const refreshed = await getPelicanAdminBatch(batch.id);
        expect(refreshed.status).toBe("COMPLETE");
        expect(refreshed.samples.map((s) => s.callStatus)).toEqual(["FAILED", "FAILED"]);
        expect(refreshed.canRun).toBe(false);
      }));
    it("soft-deletes an owned settled batch and refuses active or published records", () =>
      run(async () => {
        const draft = await create();
        const deleted = await deletePelicanBatch(draft.id);
        expect(deleted.id).toBe(draft.id);
        expect((await getPelicanAdminData()).batches.some((b) => b.id === draft.id)).toBe(false);
        expect(
          (
            await getPool().query("SELECT * FROM pelican_batch_deletions WHERE batch_id=$1", [
              draft.id,
            ])
          ).rowCount,
        ).toBe(1);
        const repeated = await deletePelicanBatch(draft.id);
        expect(repeated.id).toBe(draft.id);
        expect(
          (
            await getPool().query("SELECT * FROM pelican_batch_deletions WHERE batch_id=$1", [
              draft.id,
            ])
          ).rowCount,
        ).toBe(1);

        const active = await createTwo();
        await reserveInterruptedBatch(active.id);
        await expect(deletePelicanBatch(active.id)).rejects.toMatchObject({ status: 409 });

        const published = await create();
        await runPelicanBatch(published.id, published.budgetFingerprint);
        await publishPelicanBatch(published.id);
        await expect(deletePelicanBatch(published.id)).rejects.toMatchObject({ status: 409 });
      }));
  },
);
