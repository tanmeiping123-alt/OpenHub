import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { getPool, withTransaction } from "../db";
import { AccountError } from "../account-errors";
import { pelicanFetch } from "./transport";
import { PELICAN_PROMPT } from "@/lib/pelican-types";
import { generateWithChatModel, parseSuccess } from "../model/deepseek-provider";
import { readPelicanModelConfig } from "./config";
import { ModelServiceError } from "../model/model-errors";
import { failModelExecution } from "../model/model-repository";
import {
  finalizeModelQuota,
  markModelAttempt,
  reserveModelQuotaInTransaction,
} from "../model/model-quota-repository";
import type { LiveModelConfig, ProviderGenerateResult } from "../model/model-types";
import {
  freezePelicanConfig,
  getPelicanAdminBatch,
  requireActivePelicanAdmin,
  settlePelicanBatchStatus,
} from "./data";
import { pelicanHash, pelicanMessages, pelicanPayload } from "./policy";
import { PELICAN_ADAPTER_VERSION, preparePelicanPreview } from "./renderer";
import { forEachConcurrent, pelicanConcurrency } from "./concurrency";

function runtimeConfig(snapshot: Omit<LiveModelConfig, "apiKey">, modelKey: string) {
  const current = readPelicanModelConfig(process.env, {
    modelKey,
    strength: snapshot.strength,
    maxOutputTokens: snapshot.maxOutputTokens,
  });
  const config =
    current.mode === "LIVE"
      ? { ...current, timeoutMs: snapshot.timeoutMs, maxOutputTokens: snapshot.maxOutputTokens }
      : current;
  if (config.mode !== "LIVE" || pelicanHash(freezePelicanConfig(config)) !== pelicanHash(snapshot))
    throw new AccountError("PELICAN_CONFIGURATION_CHANGED", 409);
  return { ...config, maxRetries: 0 };
}

async function completeSettledBatch(batchId: string) {
  await settlePelicanBatchStatus(batchId);
}

export async function preparePelicanSample(sampleId: string) {
  const actor = await requireActivePelicanAdmin();
  const sample = (
    await getPool().query(
      "SELECT s.*,m.status AS execution_status,m.finish_reason FROM pelican_effective_samples s LEFT JOIN model_executions m ON m.id=s.execution_id WHERE s.id=$1",
      [sampleId],
    )
  ).rows[0];
  if (!sample || sample.execution_status !== "SUCCEEDED" || sample.raw_output === null)
    throw new AccountError("PELICAN_RESULT_NOT_READY", 409);
  if (sample.adapter_version === PELICAN_ADAPTER_VERSION) {
    await completeSettledBatch(sample.batch_id);
    return;
  }
  let preview;
  try {
    preview = await preparePelicanPreview(sample.raw_output, sample.finish_reason ?? undefined);
  } catch {
    preview = {
      html: null,
      status: "UNSUPPORTED" as const,
      reason: "PREVIEW_RUNTIME_UNAVAILABLE",
      thumbnail: null,
      adapterVersion: "pelican-preview-unavailable-v1",
    };
  }
  // Serialize competing prepare requests; an existing derivative is never silently rewritten.
  await withTransaction(async (c) => {
    await requireActivePelicanAdmin(c);
    const batch = (
      await c.query("SELECT status FROM pelican_batches WHERE id=$1 FOR UPDATE", [sample.batch_id])
    ).rows[0];
    if (["PUBLISHED", "WITHDRAWN"].includes(batch?.status))
      throw new AccountError("PELICAN_BATCH_LOCKED", 409);
    const row = (
      await c.query("SELECT adapter_version FROM pelican_samples WHERE id=$1 FOR UPDATE", [
        sampleId,
      ])
    ).rows[0];
    if (!row) throw new AccountError("PELICAN_SAMPLE_NOT_FOUND", 404);
    if (row.adapter_version !== null) {
      await c.query(
        `INSERT INTO pelican_preview_revisions(sample_id,adapter_version,raw_sha256,preview_html,preview_status,preview_reason,thumbnail,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(sample_id,adapter_version) DO NOTHING`,
        [
          sampleId,
          preview.adapterVersion,
          createHash("sha256").update(sample.raw_output).digest("hex"),
          preview.html,
          preview.status,
          preview.reason,
          preview.thumbnail,
          actor.id,
        ],
      );
      return;
    }
    await c.query(
      "UPDATE pelican_samples SET preview_html=$2,preview_status=$3,preview_reason=$4,thumbnail=$5,adapter_version=$6 WHERE id=$1",
      [
        sampleId,
        preview.html,
        preview.status,
        preview.reason,
        preview.thumbnail,
        preview.adapterVersion,
      ],
    );
  });
  await completeSettledBatch(sample.batch_id);
}

export async function cancelUndispatchedPelicanSamples(batchId: string) {
  await requireActivePelicanAdmin();
  await withTransaction(async (c) => {
    await requireActivePelicanAdmin(c);
    const batch = (await c.query("SELECT * FROM pelican_batches WHERE id=$1 FOR UPDATE", [batchId]))
      .rows[0];
    if (!batch) throw new AccountError("PELICAN_BATCH_NOT_FOUND", 404);
    if (["PUBLISHED", "WITHDRAWN"].includes(batch.status))
      throw new AccountError("PELICAN_BATCH_LOCKED", 409);
    const samples = (
      await c.query(
        `SELECT s.id sample_id,s.raw_output,s.adapter_version,m.id execution_id,m.owner_user_id,m.status,m.provider_attempt_count,m.quota_reservation_status
      FROM pelican_samples s JOIN model_executions m ON m.id=s.execution_id
      WHERE s.batch_id=$1 ORDER BY s.ordinal FOR UPDATE OF s`,
        [batchId],
      )
    ).rows;
    for (const sample of samples) {
      if (
        sample.status !== "PENDING" ||
        sample.provider_attempt_count !== 0 ||
        sample.quota_reservation_status !== "RESERVED" ||
        sample.raw_output !== null
      )
        continue;
      const cancelled = await c.query(
        `UPDATE model_executions SET status='FAILED',error_code='ADMIN_CANCELLED_UNDISPATCHED',error_message='Administrator cancelled a reserved test before any provider attempt.',latency_ms=0,completed_at=clock_timestamp()
        WHERE id=$1 AND purpose='PELICAN_TEST' AND status='PENDING' AND provider_attempt_count=0 AND quota_reservation_status='RESERVED' RETURNING id`,
        [sample.execution_id],
      );
      if (!cancelled.rowCount) continue;
      await finalizeModelQuota(c, sample.execution_id, sample.owner_user_id);
      if (sample.adapter_version === null)
        await c.query(
          "UPDATE pelican_samples SET preview_status='INVALID',preview_reason='ADMIN_CANCELLED_UNDISPATCHED',adapter_version='no-preview-v1' WHERE id=$1 AND adapter_version IS NULL",
          [sample.sample_id],
        );
    }
  });
  await completeSettledBatch(batchId);
  return getPelicanAdminBatch(batchId);
}

async function reservePelicanBatch(batchId: string, budgetFingerprint: string) {
  const actor = await requireActivePelicanAdmin();
  const quote = await getPelicanAdminBatch(batchId);
  if (quote.budgetFingerprint !== budgetFingerprint)
    throw new AccountError("PELICAN_BUDGET_CHANGED", 409);
  if (!quote.canRun)
    throw new AccountError(quote.blockedReason ?? "PELICAN_RUN_NOT_AVAILABLE", 409);
  const epoch = randomUUID();
  const jobs = await withTransaction(async (c) => {
    await requireActivePelicanAdmin(c);
    const batch = (await c.query("SELECT * FROM pelican_batches WHERE id=$1 FOR UPDATE", [batchId]))
      .rows[0];
    if (!batch || batch.owner_user_id !== actor.id)
      throw new AccountError("PELICAN_BATCH_NOT_FOUND", 404);
    if (!["DRAFT", "COMPLETE"].includes(batch.status))
      throw new AccountError("PELICAN_BATCH_LOCKED", 409);
    const rows = (
      await c.query(
        "SELECT * FROM pelican_samples WHERE batch_id=$1 AND execution_id IS NULL ORDER BY ordinal",
        [batchId],
      )
    ).rows;
    if (
      !rows.length ||
      pelicanHash(rows.map((r) => r.id)) !==
        pelicanHash(quote.samples.filter((s) => s.callStatus === "QUEUED").map((s) => s.id))
    )
      throw new AccountError("PELICAN_BUDGET_CHANGED", 409);
    const reserved = [];
    const estimates = [];
    for (const s of rows) {
      const config = runtimeConfig(s.config_snapshot, s.model_key);
      const payload = pelicanPayload(config);
      if (pelicanHash(payload) !== pelicanHash(s.request_payload))
        throw new AccountError("PELICAN_CONFIGURATION_CHANGED", 409);
      const executionId = `mex_${randomUUID()}`;
      const messages = JSON.stringify(pelicanMessages());
      const digest = pelicanHash(pelicanMessages());
      await c.query(
        `INSERT INTO model_executions(id,owner_user_id,purpose,execution_mode,status,provider,requested_model,product_version,input_sha256,requested_strength,output_token_limit,reasoning_token_reserve,model_policy_version,dispatched_messages_sha256,request_identity_sha256)
        VALUES($1,$2,'PELICAN_TEST','LIVE','PENDING',$3,$4,$5,$6,$7,$8,$9,'pelican-bare-v1',$6,$10)`,
        [
          executionId,
          actor.id,
          config.provider,
          config.model,
          config.productVersion,
          digest,
          config.strength ?? "default",
          config.maxOutputTokens,
          config.reasoningTokenReserve ?? 0,
          pelicanHash({ sampleId: s.id, payload }),
        ],
      );
      await reserveModelQuotaInTransaction(
        c,
        { executionId, config, serializedMessages: messages },
        actor.id,
      );
      const reservation = (
        await c.query(
          "SELECT pricing_snapshot_id,reserved_total_tokens,estimated_cost_usd FROM model_executions WHERE id=$1",
          [executionId],
        )
      ).rows[0];
      estimates.push({
        sampleId: s.id,
        config: freezePelicanConfig(config),
        pricingId: reservation.pricing_snapshot_id,
        tokens: Number(reservation.reserved_total_tokens),
        cost: Number(reservation.estimated_cost_usd),
      });
      await c.query("UPDATE pelican_samples SET execution_id=$2 WHERE id=$1", [s.id, executionId]);
      reserved.push({ sampleId: s.id, executionId, config, payload });
    }
    if (pelicanHash({ batchId, estimates }) !== budgetFingerprint)
      throw new AccountError("PELICAN_BUDGET_CHANGED", 409);
    await c.query("UPDATE pelican_batches SET status='RUNNING' WHERE id=$1", [batchId]);
    await c.query(
      "INSERT INTO pelican_batch_runs(batch_id,run_epoch) VALUES($1,$2) ON CONFLICT(batch_id) DO UPDATE SET run_epoch=EXCLUDED.run_epoch,started_at=clock_timestamp(),heartbeat_at=clock_timestamp(),finished_at=NULL,error_code=NULL",
      [batchId, epoch],
    );
    return reserved;
  });
  return { actor, jobs, epoch };
}

type ReservedRun = Awaited<ReturnType<typeof reservePelicanBatch>>;
type PelicanJob = ReservedRun["jobs"][number];
type PelicanActor = ReservedRun["actor"];

/**
 * Runs one reserved sample. Every job owns its execution row, quota reservation and
 * preview, so jobs can safely run in parallel; the only shared mutable state is the
 * abort-controller registry used by the stop endpoint.
 */
async function executePelicanJob(job: PelicanJob, actor: PelicanActor, runner: LocalRunner) {
  const controller = new AbortController();
  runner.active.set(job.sampleId, controller);
  let received: ProviderGenerateResult | undefined;
  let validatedResponse: ProviderGenerateResult | undefined;
  let rawOutput: string | null = null;
  let responseModel: string | null = null;
  let finishReason: string | null = null;
  const started = Date.now();
  try {
    try {
      received = await generateWithChatModel(
        job.config,
        { goal: PELICAN_PROMPT, taskType: "General", locale: "zh-CN", signal: controller.signal },
        {
          messages: pelicanMessages(),
          beforeAttempt: async () => {
            await requireActivePelicanAdmin();
            await withTransaction(async (c) => {
              await c.query("SELECT id FROM pelican_samples WHERE id=$1 FOR UPDATE", [
                job.sampleId,
              ]);
              const stopped = (
                await c.query(
                  "SELECT stop_requested_at FROM pelican_sample_controls WHERE sample_id=$1",
                  [job.sampleId],
                )
              ).rows[0];
              if (stopped?.stop_requested_at || controller.signal.aborted)
                throw new ModelServiceError(
                  "MODEL_REQUEST_CANCELLED",
                  "Administrator stopped this test.",
                  408,
                );
              await markModelAttempt(job.executionId, actor.id);
              await c.query(
                "INSERT INTO pelican_sample_controls(sample_id,started_at) VALUES($1,clock_timestamp()) ON CONFLICT(sample_id) DO UPDATE SET started_at=COALESCE(pelican_sample_controls.started_at,EXCLUDED.started_at)",
                [job.sampleId],
              );
            });
          },
          fetchImpl: async (url, init) => {
            if (
              url !== `${job.config.baseUrl}/chat/completions` ||
              pelicanHash(JSON.parse(String(init?.body))) !== pelicanHash(job.payload)
            )
              throw new ModelServiceError(
                "PELICAN_DISPATCH_MISMATCH",
                "Frozen test payload differs from dispatch.",
                409,
              );
            const response = await pelicanFetch(url, init);
            if (response.ok) {
              // Retain original content before the shared adapter's body trimming/validation.
              try {
                const payload = await response.clone().json();
                const first = payload?.choices?.[0];
                if (typeof first?.message?.content === "string")
                  rawOutput = first.message.content;
                if (typeof payload.model === "string") responseModel = payload.model;
                if (typeof first?.finish_reason === "string") finishReason = first.finish_reason;
                // Empty output is a real result too. Preserve valid usage even when the
                // general-purpose adapter rejects an empty final answer.
                validatedResponse = parseSuccess(
                  payload,
                  job.config.model,
                  Date.now() - started,
                  true,
                );
              } catch {
                /* Shared adapter classifies malformed or unknown results. */
              }
            }
            return response;
          },
        },
      ).catch((error) => {
        if (
          error instanceof ModelServiceError &&
          ["DEEPSEEK_INVALID_RESPONSE", "SILICONFLOW_INVALID_RESPONSE"].includes(error.code) &&
          validatedResponse &&
          rawOutput !== null
        )
          return validatedResponse;
        throw error;
      });
      received = { ...received, content: rawOutput ?? received.content };
      await withTransaction(async (c) => {
        const r = received!;
        // Cancellation claims the sample lock before inspecting its execution.
        // Use the same order when saving a response to avoid a stop/save deadlock.
        await c.query("SELECT id FROM pelican_samples WHERE id=$1 FOR UPDATE", [job.sampleId]);
        const saved = await c.query(
          `UPDATE model_executions SET status='SUCCEEDED',output_text=$3,resolved_model=$4,provider_request_id=$5,system_fingerprint=$6,prompt_tokens=$7,completion_tokens=$8,total_tokens=$9,prompt_cache_hit_tokens=$10,prompt_cache_miss_tokens=$11,reasoning_tokens=$12,finish_reason=$13,latency_ms=$14,completed_at=clock_timestamp()
          WHERE id=$1 AND owner_user_id=$2 AND status='PENDING' RETURNING id`,
          [
            job.executionId,
            actor.id,
            r.content,
            responseModel,
            r.providerRequestId ?? null,
            r.systemFingerprint ?? null,
            r.usage.promptTokens,
            r.usage.completionTokens,
            r.usage.totalTokens,
            r.usage.promptCacheHitTokens ?? null,
            r.usage.promptCacheMissTokens ?? null,
            r.usage.reasoningTokens ?? null,
            finishReason,
            r.latencyMs,
          ],
        );
        if (!saved.rowCount) throw new AccountError("PELICAN_EXECUTION_CONFLICT", 409);
        await c.query(
          "UPDATE pelican_samples SET raw_output=$2,response_model=$3,response_finish_reason=$4 WHERE id=$1",
          [job.sampleId, r.content, responseModel, finishReason],
        );
        await finalizeModelQuota(c, job.executionId, actor.id, r.usage);
      });
    } catch (error) {
      const code = error instanceof ModelServiceError ? error.code : "PELICAN_EXECUTION_FAILED";
      await failModelExecution(job.executionId, {
        code,
        message:
          "The test result is incomplete or unavailable; inspect this execution and its usage before running another sample.",
        latencyMs: Date.now() - started,
        result: received,
      }).catch(() => undefined);
      if (rawOutput !== null)
        await getPool()
          .query(
            "UPDATE pelican_samples SET raw_output=$2,response_model=$3,response_finish_reason=$4 WHERE id=$1 AND raw_output IS NULL",
            [job.sampleId, rawOutput, responseModel, finishReason],
          )
          .catch(() => undefined);
      await getPool()
        .query(
          "UPDATE pelican_samples SET preview_status='INVALID',preview_reason='MODEL_CALL_NOT_COMPLETED',adapter_version='no-preview-v1' WHERE id=$1 AND adapter_version IS NULL",
          [job.sampleId],
        )
        .catch(() => undefined);
      return;
    }
  } finally {
    runner.active.delete(job.sampleId);
  }
  try {
    await preparePelicanSample(job.sampleId);
  } catch {
    // A preview persistence/read interruption must not strand other reserved jobs.
    // Preserve its saved raw result and PENDING preview for explicit preparation.
  }
}

async function executePelicanBatch(batchId: string, { actor, jobs, epoch }: ReservedRun) {
  const runner = createPelicanRunner(batchId, epoch);
  try {
    // Bounded parallel dispatch: a slow model no longer holds every later sample
    // behind its full generation time. Provider rate limits and account quotas still
    // apply independently to each request.
    await forEachConcurrent(jobs, pelicanConcurrency(), (job) =>
      executePelicanJob(job, actor, runner),
    );
    await completeSettledBatch(batchId);
    return await getPelicanAdminBatch(batchId);
  } finally {
    clearInterval(runner.timer);
    if (runners.get(batchId) === runner) runners.delete(batchId);
    await getPool().query(
      "UPDATE pelican_batch_runs SET heartbeat_at=clock_timestamp(),finished_at=clock_timestamp() WHERE batch_id=$1 AND run_epoch=$2",
      [batchId, runner.epoch],
    );
  }
}

type LocalRunner = {
  epoch: string;
  active: Map<string, AbortController>;
  timer: ReturnType<typeof setInterval>;
};
const runnerKey = Symbol.for("promptmaster.pelican.runners");
const runnerGlobal = globalThis as typeof globalThis & { [runnerKey]?: Map<string, LocalRunner> };
const runners = (runnerGlobal[runnerKey] ??= new Map<string, LocalRunner>());
function createPelicanRunner(batchId: string, epoch: string): LocalRunner {
  const runner: LocalRunner = {
    epoch,
    active: new Map(),
    timer: undefined as unknown as ReturnType<typeof setInterval>,
  };
  let checking = false;
  runner.timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void (async () => {
      await getPool().query(
        "UPDATE pelican_batch_runs SET heartbeat_at=clock_timestamp() WHERE batch_id=$1 AND run_epoch=$2 AND finished_at IS NULL",
        [batchId, runner.epoch],
      );
      const stopped = (
        await getPool().query(
          "SELECT ctl.sample_id FROM pelican_sample_controls ctl JOIN pelican_samples s ON s.id=ctl.sample_id WHERE s.batch_id=$1 AND ctl.stop_requested_at IS NOT NULL",
          [batchId],
        )
      ).rows;
      for (const row of stopped) runner.active.get(row.sample_id)?.abort();
    })()
      .catch(() => {
        /* Persisted heartbeat becomes stale; never redispatch on recovery. */
      })
      .finally(() => {
        checking = false;
      });
  }, 1000);
  runner.timer.unref?.();
  runners.set(batchId, runner);
  return runner;
}
export async function runPelicanBatch(batchId: string, fingerprint: string) {
  const reserved = await reservePelicanBatch(batchId, fingerprint);
  return executePelicanBatch(batchId, reserved);
}
export async function startPelicanBatch(batchId: string, fingerprint: string) {
  const reserved = await reservePelicanBatch(batchId, fingerprint);
  const accepted = await getPelicanAdminBatch(batchId);
  // A detached continuation inherits the authenticated AsyncLocalStorage actor.
  void executePelicanBatch(batchId, reserved).catch(async () => {
    await getPool()
      .query(
        "UPDATE pelican_batch_runs SET error_code='PELICAN_RUN_INTERRUPTED',finished_at=clock_timestamp() WHERE batch_id=$1 AND run_epoch=$2",
        [batchId, reserved.epoch],
      )
      .catch(() => undefined);
  });
  return accepted;
}
export async function stopPelicanBatch(batchId: string, sampleId?: string) {
  const actor = await requireActivePelicanAdmin();
  const stopped: string[] = [];
  const localRunner = runners.get(batchId);
  await withTransaction(async (c) => {
    await requireActivePelicanAdmin(c);
    const batch = (await c.query("SELECT * FROM pelican_batches WHERE id=$1 FOR UPDATE", [batchId]))
      .rows[0];
    if (!batch || batch.owner_user_id !== actor.id)
      throw new AccountError("PELICAN_BATCH_NOT_FOUND", 404);
    if (["PUBLISHED", "WITHDRAWN"].includes(batch.status))
      throw new AccountError("PELICAN_BATCH_LOCKED", 409);
    const run = (
      await c.query("SELECT * FROM pelican_batch_runs WHERE batch_id=$1 FOR UPDATE", [batchId])
    ).rows[0];
    const runLive =
      !!run &&
      !run.finished_at &&
      !run.error_code &&
      Date.now() - new Date(run.heartbeat_at).getTime() <= 90000;
    const finalizeOrphan = !localRunner?.active.size && !runLive;
    const rows = (
      await c.query(
        `SELECT s.id sample_id,s.adapter_version,m.* FROM pelican_samples s LEFT JOIN model_executions m ON m.id=s.execution_id WHERE s.batch_id=$1 AND ($2::text IS NULL OR s.id=$2) ORDER BY s.ordinal FOR UPDATE OF s`,
        [batchId, sampleId ?? null],
      )
    ).rows;
    let finalized = 0;
    if (sampleId && !rows.length) throw new AccountError("PELICAN_SAMPLE_NOT_FOUND", 404);
    for (const row of rows) {
      if (row.status !== "PENDING") continue;
      await c.query(
        "INSERT INTO pelican_sample_controls(sample_id,stop_requested_at,stop_requested_by) VALUES($1,clock_timestamp(),$2) ON CONFLICT(sample_id) DO UPDATE SET stop_requested_at=COALESCE(pelican_sample_controls.stop_requested_at,EXCLUDED.stop_requested_at),stop_requested_by=COALESCE(pelican_sample_controls.stop_requested_by,EXCLUDED.stop_requested_by)",
        [row.sample_id, actor.id],
      );
      stopped.push(row.sample_id);
      if (row.provider_attempt_count === 0 && row.quota_reservation_status === "RESERVED") {
        const cancelled = await c.query(
          "UPDATE model_executions SET status='FAILED',error_code='ADMIN_CANCELLED_UNDISPATCHED',error_message='Administrator stopped this test before any provider attempt.',latency_ms=0,completed_at=clock_timestamp() WHERE id=$1 AND status='PENDING' AND provider_attempt_count=0 AND quota_reservation_status='RESERVED' RETURNING id",
          [row.id],
        );
        if (cancelled.rowCount) {
          await finalizeModelQuota(c, row.id, actor.id);
          await c.query(
            "UPDATE pelican_samples SET preview_status='INVALID',preview_reason='ADMIN_CANCELLED_UNDISPATCHED',adapter_version='no-preview-v1' WHERE id=$1 AND adapter_version IS NULL",
            [row.sample_id],
          );
        }
        continue;
      }
      if (!finalizeOrphan) continue;
      const interrupted = await c.query(
        "UPDATE model_executions SET status='FAILED',error_code='PELICAN_RUN_INTERRUPTED',error_message='Stopped after the background worker was interrupted; provider usage may still be charged.',completed_at=clock_timestamp() WHERE id=$1 AND status='PENDING' RETURNING id",
        [row.id],
      );
      if (!interrupted.rowCount) continue;
      await finalizeModelQuota(c, row.id, actor.id);
      await c.query(
        "UPDATE pelican_samples SET preview_status='INVALID',preview_reason='PELICAN_RUN_INTERRUPTED',adapter_version='no-preview-v1' WHERE id=$1 AND adapter_version IS NULL",
        [row.sample_id],
      );
      finalized++;
    }
    if (finalized)
      await c.query(
        "UPDATE pelican_batch_runs SET heartbeat_at=clock_timestamp(),finished_at=clock_timestamp(),error_code=COALESCE(error_code,'PELICAN_RUN_INTERRUPTED') WHERE batch_id=$1 AND finished_at IS NULL",
        [batchId],
      );
  });
  for (const id of stopped) runners.get(batchId)?.active.get(id)?.abort();
  await settlePelicanBatchStatus(batchId);
  return getPelicanAdminBatch(batchId);
}
