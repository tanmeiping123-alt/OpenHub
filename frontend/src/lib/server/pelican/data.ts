import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import {
  MODEL_CATALOG,
  catalogModel,
  type ModelSelection,
  type PublicModelOption,
} from "@/lib/model-catalog";
import {
  PELICAN_CHALLENGE_VERSION,
  PELICAN_PROMPT,
  type PelicanAdminBatch,
  type PelicanAdminData,
  type PelicanBatch,
  type PelicanListing,
  type PelicanRunBlock,
  type PelicanSample,
} from "@/lib/pelican-types";
import { AccountError } from "../account-errors";
import { ensureDatabaseReady, getPool, withTransaction } from "../db";
import { readPelicanModelConfig, pelicanModelOutputCeiling } from "./config";
import { getModelQuotaSummary } from "../model/model-quota-repository";
import {
  estimatePromptTokens,
  estimateReservedCostUsd,
  resolvePricingWindow,
  roundCostUp,
  type ModelPricingSnapshot,
} from "../model/model-pricing";
import type { LiveModelConfig } from "../model/model-types";
import {
  parsePelicanCreate,
  pelicanHash,
  pelicanMessages,
  pelicanPayload,
  requirePelicanAdmin,
} from "./policy";

export type PelicanFrozenConfig = Omit<LiveModelConfig, "apiKey">;
// Explicit allowlist: no credentials, ambient environment or unrelated source context.
export function freezePelicanConfig(
  config: LiveModelConfig | PelicanFrozenConfig,
): PelicanFrozenConfig {
  return {
    mode: "LIVE",
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    productVersion: config.productVersion,
    timeoutMs: config.timeoutMs,
    maxRetries: 0,
    maxOutputTokens: config.maxOutputTokens,
    dailyTokenLimit: config.dailyTokenLimit,
    dailyCostLimitUsd: config.dailyCostLimitUsd,
    pricingWindow: config.pricingWindow,
    strength: config.strength ?? "off",
    reasoningTokenReserve: config.reasoningTokenReserve ?? 0,
  };
}
export async function requireActivePelicanAdmin(client?: PoolClient) {
  const actor = requirePelicanAdmin();
  if (!client) await ensureDatabaseReady();
  const result = await (client ?? getPool()).query(
    `SELECT a.user_id FROM administrator_users a JOIN app_users u ON u.id=a.user_id WHERE a.user_id=$1 AND NOT a.disabled AND u.account_kind='ADMIN'`,
    [actor.id],
  );
  if (!result.rowCount) throw new AccountError("ADMIN_REQUIRED", 403);
  return actor;
}
const pageNumber = (value: unknown) =>
  typeof value === "number"
    ? Number.isSafeInteger(value) && value >= 1 && value <= 100000
      ? value
      : 1
    : typeof value === "string" && /^[1-9]\d{0,5}$/.test(value) && Number(value) <= 100000
      ? Number(value)
      : 1;
const timestamp = (value: unknown): string | null =>
  value ? new Date(value as string).toISOString() : null;
const selectionFor = (row: QueryResultRow): ModelSelection => ({
  modelKey: row.model_key,
  strength: row.config_snapshot.strength,
  maxOutputTokens: row.config_snapshot.maxOutputTokens,
});
function liveConfig(selection: ModelSelection) {
  const config = readPelicanModelConfig(process.env, selection);
  if (config.mode !== "LIVE") throw new AccountError("MODEL_DISABLED", 503);
  if (
    config.provider === "deepseek" &&
    !["https://api.deepseek.com", "https://api.deepseek.com/v1"].includes(config.baseUrl)
  )
    throw new AccountError("MODEL_CONFIGURATION_ERROR", 503);
  return { ...config, maxRetries: 0 };
}
const sampleSql = `SELECT s.*,e.status execution_status,e.created_at execution_created_at, e.error_code,e.error_message,
  ctl.started_at,ctl.stop_requested_at,run.heartbeat_at run_heartbeat_at,run.error_code run_error_code,run.finished_at run_finished_at, b.status batch_status,b.owner_user_id batch_owner_user_id,

  0::bigint execution_queue_allowance_ms,
  e.completed_at,e.latency_ms,e.quota_reservation_status,e.reconciliation_status,e.provider_attempt_count,e.prompt_tokens,e.completion_tokens,e.total_tokens FROM pelican_effective_samples s LEFT JOIN model_executions e ON e.id=s.execution_id
  JOIN pelican_batches b ON b.id=s.batch_id LEFT JOIN pelican_sample_controls ctl ON ctl.sample_id=s.id
  LEFT JOIN pelican_batch_runs run ON run.batch_id=s.batch_id`;
async function sampleRows(
  batchId: string,
  client: Pick<PoolClient, "query"> = getPool(),
  includeHidden = false,
) {
  return (
    await client.query(
      `${sampleSql} WHERE s.batch_id=$1 ${includeHidden ? "" : "AND NOT EXISTS(SELECT 1 FROM pelican_sample_deletions d WHERE d.sample_id=s.id)"} ORDER BY s.ordinal`,
      [batchId],
    )
  ).rows;
}
function pelicanActorId() {
  try {
    return requirePelicanAdmin().id;
  } catch {
    return null;
  }
}
function sampleDto(row: QueryResultRow): PelicanSample {
  const c = row.config_snapshot as PelicanFrozenConfig;
  // Read-only uncertainty: never release a dispatched reservation or infer supplier billing.
  // Jobs share a reservation timestamp but dispatch concurrently through a bounded pool, so
  // the deadline uses this sample's own timeout rather than accumulating earlier jobs' time.
  const overdue =
    c.timeoutMs > 0 &&
    !row.run_heartbeat_at &&
    row.execution_status === "PENDING" &&
    row.provider_attempt_count > 0 &&
    row.execution_created_at &&
    Date.now() - new Date(row.execution_created_at).getTime() >
      Number(row.execution_queue_allowance_ms ?? 0) + c.timeoutMs + 60000;
  const orphaned =
    c.timeoutMs === 0 &&
    row.execution_status === "PENDING" &&
    !row.run_heartbeat_at &&
    row.provider_attempt_count > 0 &&
    row.execution_created_at &&
    Date.now() - new Date(row.execution_created_at).getTime() > 90000;
  const interrupted =
    row.execution_status === "PENDING" &&
    ((row.run_heartbeat_at &&
      (row.run_finished_at ||
        row.run_error_code ||
        Date.now() - new Date(row.run_heartbeat_at).getTime() > 90000)) ||
      orphaned);
  const callStatus = !row.execution_id
    ? "QUEUED"
    : overdue ||
        interrupted ||
        row.quota_reservation_status === "HELD" ||
        row.reconciliation_status === "REQUIRED"
      ? "UNKNOWN"
      : row.execution_status;
  return {
    id: row.id,
    batchId: row.batch_id,
    modelKey: row.model_key,
    modelName: row.model_name,
    provider: c.provider,
    requestedModel: c.model,
    resolvedModel: row.response_model ?? null,
    strength: c.strength ?? "off",
    maxOutputTokens: c.maxOutputTokens,
    reasoningTokenReserve: c.reasoningTokenReserve ?? 0,
    timeoutMs: c.timeoutMs,
    generatedAt: timestamp(row.completed_at),
    startedAt:
      timestamp(row.started_at) ??
      (row.provider_attempt_count > 0 ? timestamp(row.execution_created_at) : null),
    errorCode: interrupted ? "PELICAN_RUN_INTERRUPTED" : (row.error_code ?? null),
    errorMessage: interrupted
      ? "Background execution was interrupted. Check provider usage before another attempt."
      : (row.error_message ?? null),
    stopRequested: !!row.stop_requested_at,
    canStop: row.batch_owner_user_id === pelicanActorId() && row.execution_status === "PENDING",
    canDelete:
      row.batch_owner_user_id === pelicanActorId() &&
      row.execution_status === "FAILED" &&
      ["DRAFT", "RUNNING", "COMPLETE"].includes(row.batch_status),
    latencyMs: row.latency_ms ?? null,
    callStatus,
    previewStatus: row.preview_status,
    previewReason: row.preview_reason ?? null,
    finishReason: row.response_finish_reason ?? null,
    rerunOf: row.rerun_of ?? null,
    interrupted,
    hasThumbnail: !!row.thumbnail,
    withdrawn: !!row.withdrawn_at,
    withdrawnReason: row.withdrawn_reason ?? null,
  };
}
function batchDto(row: QueryResultRow, samples: QueryResultRow[]): PelicanBatch {
  return {
    id: row.id,
    title: row.title,
    challengeVersion: row.challenge_version,
    createdAt: timestamp(row.created_at)!,
    publishedAt: timestamp(row.published_at),
    status: row.status,
    samples: samples.map(sampleDto),
  };
}
function publishable(samples: QueryResultRow[]) {
  return (
    samples.length > 0 &&
    samples.every(
      (s) =>
        s.execution_id &&
        ["SUCCEEDED", "FAILED"].includes(s.execution_status) &&
        s.preview_status !== "PENDING" &&
        !["HELD", "RESERVED"].includes(s.quota_reservation_status) &&
        !["REQUIRED", "DISCREPANCY"].includes(s.reconciliation_status) &&
        (s.quota_reservation_status === "SETTLED" ||
          (s.execution_status === "FAILED" &&
            s.provider_attempt_count === 0 &&
            ["NOT_RESERVED", "RELEASED"].includes(s.quota_reservation_status))),
    )
  );
}
function nextUtcReset(usageDay: string) {
  const start = Date.parse(`${usageDay}T00:00:00.000Z`);
  return Number.isFinite(start) ? new Date(start + 86400000).toISOString() : undefined;
}
async function quoteBatch(
  row: QueryResultRow,
  samples: QueryResultRow[],
): Promise<PelicanAdminBatch> {
  const actor = requirePelicanAdmin();
  const queued = samples.filter((s) => !s.execution_id);
  const estimates: {
    sampleId: string;
    config: PelicanFrozenConfig;
    pricingId: string;
    tokens: number;
    cost: number;
  }[] = [];
  let blockedReason: string | null = null;
  let runBlock: PelicanRunBlock | null = null;
  let canRun =
    ["DRAFT", "COMPLETE"].includes(row.status) &&
    queued.length > 0 &&
    row.owner_user_id === actor.id &&
    !samples.some((s) => s.execution_status === "PENDING");
  if (row.owner_user_id !== actor.id) blockedReason = "BATCH_OWNER_REQUIRED";
  else if (!["DRAFT", "COMPLETE"].includes(row.status) || !queued.length)
    blockedReason = "BATCH_NOT_RUNNABLE";
  else if (samples.some((s) => s.execution_status === "PENDING"))
    blockedReason = "BATCH_RESULT_PENDING";
  try {
    const configs: LiveModelConfig[] = [];
    for (const sample of queued) {
      const config = {
        ...liveConfig(selectionFor(sample)),
        timeoutMs: sample.config_snapshot.timeoutMs,
        maxOutputTokens: sample.config_snapshot.maxOutputTokens,
      };
      if (
        pelicanHash(freezePelicanConfig(config)) !==
        pelicanHash(freezePelicanConfig(sample.config_snapshot))
      )
        throw new AccountError("MODEL_CONFIGURATION_CHANGED", 409);
      const price = (
        await getPool().query(
          `SELECT * FROM model_pricing_snapshots WHERE provider=$1 AND requested_model=$2 AND product_version=$3 AND pricing_window=$4 AND effective_at<=now() AND valid_until>now() ORDER BY effective_at DESC,captured_at DESC,id DESC LIMIT 1`,
          [
            config.provider,
            config.model,
            config.productVersion,
            resolvePricingWindow(config.pricingWindow),
          ],
        )
      ).rows[0];
      if (!price) throw new AccountError("MODEL_PRICING_UNAVAILABLE", 503);
      const pricing: ModelPricingSnapshot = {
        id: price.id,
        pricingWindow: price.pricing_window,
        inputCacheHitUsdPerMillion: Number(price.input_cache_hit_usd_per_million),
        inputCacheMissUsdPerMillion: Number(price.input_cache_miss_usd_per_million),
        outputUsdPerMillion: Number(price.output_usd_per_million),
        sourceUrl: price.source_url,
      };
      const promptTokens = estimatePromptTokens(JSON.stringify(pelicanMessages()));
      const output = config.maxOutputTokens + (config.reasoningTokenReserve ?? 0);
      estimates.push({
        sampleId: sample.id,
        config: freezePelicanConfig(config),
        pricingId: price.id,
        tokens: promptTokens + output,
        cost: estimateReservedCostUsd(pricing, promptTokens, output),
      });
      configs.push(config);
    }
    const tokens = estimates.reduce((n, e) => n + e.tokens, 0),
      cost = roundCostUp(estimates.reduce((n, e) => n + e.cost, 0));
    if (canRun)
      for (let index = 0; index < configs.length; index++) {
        const quota = await getModelQuotaSummary(configs[index]);
        if (!quota.enabled || quota.frozen) throw new AccountError("MODEL_QUOTA_EXCEEDED", 429);
        const dailyTokens = tokens > quota.remainingTokens;
        const dailyCost = cost > quota.remainingCostUsd;
        const periodTokens = tokens > quota.periodRemainingTokens;
        const periodCost = cost > quota.periodRemainingCostUsd;
        const platformDaily =
          !quota.unlimited &&
          roundCostUp(quota.platform.dailyUsedUsd + cost) > quota.platform.dailyLimitUsd;
        const platformPeriod =
          !quota.unlimited &&
          roundCostUp(quota.platform.periodUsedUsd + cost) > quota.platform.periodLimitUsd;
        if (
          !dailyTokens &&
          !dailyCost &&
          !periodTokens &&
          !periodCost &&
          !platformDaily &&
          !platformPeriod
        )
          continue;
        const platform = platformDaily || platformPeriod;
        const period = !platform && (periodTokens || periodCost);
        runBlock = {
          code: "MODEL_QUOTA_EXCEEDED",
          modelName: configs[index].productVersion,
          requiredTokens: tokens,
          requiredCostUsd: cost,
          scope: platform ? "platform" : period ? "period" : "daily",
          ...(platform
            ? {
                remainingCostUsd: Math.max(
                  0,
                  platformDaily
                    ? quota.platform.dailyLimitUsd - quota.platform.dailyUsedUsd
                    : quota.platform.periodLimitUsd - quota.platform.periodUsedUsd,
                ),
                resetAt: platformDaily ? nextUtcReset(quota.usageDay) : quota.platform.periodEnd,
              }
            : {
                remainingTokens: period ? quota.periodRemainingTokens : quota.remainingTokens,
                remainingCostUsd: period ? quota.periodRemainingCostUsd : quota.remainingCostUsd,
                resetAt: period ? quota.periodEnd : nextUtcReset(quota.usageDay),
              }),
        };
        throw new AccountError("MODEL_QUOTA_EXCEEDED", 429);
      }
  } catch (error) {
    canRun = false;
    blockedReason =
      error instanceof AccountError
        ? error.code
        : error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "MODEL_CONFIGURATION_UNAVAILABLE";
    runBlock = runBlock ?? { code: blockedReason };
  }
  if (process.env.PROMPTMASTER_DEPLOYMENT_MODE === "cloudflare-workers") {
    canRun = false;
    blockedReason = "PELICAN_UNAVAILABLE_ON_FREE_CLOUD";
    runBlock = { code: blockedReason };
  }
  if (!runBlock && blockedReason) runBlock = { code: blockedReason };
  return {
    ...batchDto(row, samples),
    estimatedCostUsd: roundCostUp(estimates.reduce((n, e) => n + e.cost, 0)),
    estimatedTokens: estimates.reduce((n, e) => n + e.tokens, 0),
    budgetFingerprint: pelicanHash({ batchId: row.id, estimates }),
    canRun,
    canPublish:
      ["DRAFT", "COMPLETE", "WITHDRAWN"].includes(row.status) &&
      publishable(await sampleRows(row.id, getPool(), true)),
    canDelete:
      row.owner_user_id === actor.id &&
      ["DRAFT", "COMPLETE"].includes(row.status) &&
      !samples.some((s) => s.execution_status === "PENDING"),
    blockedReason,
    runBlock,
  };
}

export async function createPelicanBatch(input: unknown): Promise<PelicanAdminBatch> {
  const actor = await requireActivePelicanAdmin();
  const parsed = parsePelicanCreate(input);
  const identity = pelicanHash({
    title: parsed.title,
    selections: parsed.selections,
    challengeVersion: PELICAN_CHALLENGE_VERSION,
  });
  const id = await withTransaction(async (c) => {
    await requireActivePelicanAdmin(c);
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `pelican-create:${actor.id}:${parsed.requestKey}`,
    ]);
    const previous = (
      await c.query("SELECT * FROM pelican_batches WHERE owner_user_id=$1 AND request_key=$2", [
        actor.id,
        parsed.requestKey,
      ])
    ).rows[0];
    if (previous) {
      if (previous.identity_sha256 !== identity)
        throw new AccountError("PELICAN_REQUEST_CONFLICT", 409);
      if (
        (await c.query("SELECT 1 FROM pelican_batch_deletions WHERE batch_id=$1", [previous.id]))
          .rowCount
      )
        throw new AccountError("PELICAN_REQUEST_DELETED", 409);
      return previous.id as string;
    }
    const snapshots = parsed.selections.map((selection) => {
      const config = liveConfig(selection);
      return {
        key: catalogModel(selection.modelKey)!.key,
        name: config.productVersion,
        config: freezePelicanConfig(config),
        payload: pelicanPayload(config),
      };
    });
    const batchId = `pelican_${randomUUID()}`;
    await c.query(
      `INSERT INTO pelican_batches(id,owner_user_id,request_key,identity_sha256,title,challenge_version,prompt_text) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        batchId,
        actor.id,
        parsed.requestKey,
        identity,
        parsed.title,
        PELICAN_CHALLENGE_VERSION,
        PELICAN_PROMPT,
      ],
    );
    for (let n = 0; n < snapshots.length; n++) {
      const s = snapshots[n];
      await c.query(
        `INSERT INTO pelican_samples(id,batch_id,ordinal,model_key,model_name,config_snapshot,request_payload) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          `pelican_sample_${randomUUID()}`,
          batchId,
          n + 1,
          s.key,
          s.name,
          JSON.stringify(s.config),
          JSON.stringify(s.payload),
        ],
      );
    }
    return batchId;
  });
  return getPelicanAdminBatch(id);
}
export async function settlePelicanBatchStatus(
  batchId: string,
  client: Pick<PoolClient, "query"> = getPool(),
) {
  await client.query(
    `UPDATE pelican_batches b SET status='COMPLETE'
     WHERE b.id=$1 AND b.status='RUNNING' AND NOT EXISTS(
       SELECT 1 FROM pelican_samples s JOIN model_executions m ON m.id=s.execution_id
       WHERE s.batch_id=b.id AND m.status='PENDING'
     )`,
    [batchId],
  );
}
export async function getPelicanAdminBatch(id: string): Promise<PelicanAdminBatch> {
  await requireActivePelicanAdmin();
  await settlePelicanBatchStatus(id);
  const row = (await getPool().query("SELECT * FROM pelican_batches WHERE id=$1", [id])).rows[0];
  if (!row) throw new AccountError("PELICAN_BATCH_NOT_FOUND", 404);
  return quoteBatch(row, await sampleRows(id));
}
async function publicOptions(): Promise<PublicModelOption[]> {
  const result: PublicModelOption[] = [];
  for (const item of MODEL_CATALOG) {
    try {
      const config = liveConfig({ modelKey: item.key });
      const price = (
        await getPool().query(
          `SELECT * FROM model_pricing_snapshots WHERE provider=$1 AND requested_model=$2 AND product_version=$3 AND pricing_window=$4 AND effective_at<=now() AND valid_until>now() ORDER BY effective_at DESC,captured_at DESC,id DESC LIMIT 1`,
          [
            config.provider,
            config.model,
            config.productVersion,
            resolvePricingWindow(config.pricingWindow),
          ],
        )
      ).rows[0];
      result.push({
        key: item.key,
        configured: !!price,
        maxOutputTokens: pelicanModelOutputCeiling(process.env, item.key),
        timeoutMs: config.timeoutMs,
        ...(price?.native_currency === "CNY"
          ? {
              pricing: {
                currency: "CNY" as const,
                inputPerMillion: Number(price.native_input_per_million),
                outputPerMillion: Number(price.native_output_per_million),
                cacheHitPerMillion: Number(price.native_cache_hit_per_million),
                budgetUsdPerUnit: Number(price.budget_usd_per_native_unit),
                sourceUrl: price.source_url,
                validUntil: timestamp(price.valid_until)!,
              },
            }
          : {}),
      });
    } catch {
      result.push({ key: item.key, configured: false });
    }
  }
  return result;
}
export async function getPelicanAdminData({
  page = 1,
  requestKey,
  rerunRequestKey,
  query,
  modelKey,
  status = "all",
}: {
  page?: number;
  requestKey?: string;
  rerunRequestKey?: string;
  query?: string;
  modelKey?: string;
  status?: string;
} = {}): Promise<PelicanAdminData> {
  const actor = await requireActivePelicanAdmin();
  await getPool().query(
    `UPDATE pelican_batches b SET status='COMPLETE'
     WHERE b.owner_user_id=$1 AND b.status='RUNNING' AND NOT EXISTS(
       SELECT 1 FROM pelican_samples s JOIN model_executions m ON m.id=s.execution_id
       WHERE s.batch_id=b.id AND m.status='PENDING'
     )`,
    [actor.id],
  );
  const p = pageNumber(page);
  if (
    (query?.length ?? 0) > 120 ||
    (modelKey?.length ?? 0) > 120 ||
    !["all", "queued", "running", "succeeded", "failed", "unknown"].includes(status)
  )
    throw new AccountError("INVALID_INPUT");
  const filterQuery = requestKey || rerunRequestKey ? null : query?.trim() || null;
  const filterModel = requestKey || rerunRequestKey ? null : modelKey?.trim() || null;
  const filterStatus = requestKey || rerunRequestKey ? "all" : status;
  const rows = (
    await getPool().query(
      `SELECT b.* FROM pelican_batches b WHERE NOT EXISTS(SELECT 1 FROM pelican_batch_deletions bd WHERE bd.batch_id=b.id) AND ($1::text IS NULL OR (b.request_key=$1 AND b.owner_user_id=$2)) AND ($4::text IS NULL OR EXISTS(SELECT 1 FROM pelican_samples s WHERE s.batch_id=b.id AND s.rerun_request_key=$4)) AND (($1::text IS NOT NULL OR $4::text IS NOT NULL) OR EXISTS(SELECT 1 FROM pelican_samples s
      LEFT JOIN model_executions m ON m.id=s.execution_id LEFT JOIN pelican_batch_runs r ON r.batch_id=s.batch_id
      WHERE s.batch_id=b.id AND NOT EXISTS(SELECT 1 FROM pelican_sample_deletions d WHERE d.sample_id=s.id)
      AND ($5::text IS NULL OR position(lower($5) in lower(b.title || ' ' || s.model_name || ' ' || s.model_key || ' ' || s.id))>0)
      AND ($6::text IS NULL OR s.model_key=$6)
      AND ($7='all' OR CASE
        WHEN s.execution_id IS NULL THEN 'queued'
        WHEN m.quota_reservation_status='HELD' OR m.reconciliation_status='REQUIRED' OR
          (m.status='PENDING' AND r.batch_id IS NOT NULL AND (r.finished_at IS NOT NULL OR r.error_code IS NOT NULL OR r.heartbeat_at<$8::timestamptz-interval '90 seconds')) OR
          (m.status='PENDING' AND r.batch_id IS NULL AND m.provider_attempt_count>0 AND (((s.config_snapshot->>'timeoutMs')::bigint=0 AND $8::timestamptz-m.created_at > interval '90 seconds') OR ((s.config_snapshot->>'timeoutMs')::bigint>0 AND
           $8::timestamptz-m.created_at > ((s.config_snapshot->>'timeoutMs')::bigint+60000)*interval '1 millisecond'))) THEN 'unknown'
        WHEN m.status='PENDING' THEN 'running' WHEN m.status='SUCCEEDED' THEN 'succeeded' ELSE 'failed' END=$7)
      )) ORDER BY b.created_at DESC,b.id DESC LIMIT 7 OFFSET $3`,
      [
        requestKey ?? null,
        actor.id,
        (p - 1) * 6,
        rerunRequestKey ?? null,
        filterQuery,
        filterModel,
        filterStatus,
        new Date(Date.now()).toISOString(),
      ],
    )
  ).rows;
  const batches = [];
  for (const row of rows.slice(0, 6)) {
    const batch = await quoteBatch(row, await sampleRows(row.id));
    if (!requestKey && !rerunRequestKey)
      batch.samples = batch.samples.filter(
        (s) =>
          (!filterQuery ||
            [row.title, s.modelName, s.modelKey, s.id]
              .join(" ")
              .toLowerCase()
              .includes(filterQuery.toLowerCase())) &&
          (!filterModel || s.modelKey === filterModel) &&
          (filterStatus === "all" ||
            {
              QUEUED: "queued",
              PENDING: "running",
              SUCCEEDED: "succeeded",
              FAILED: "failed",
              UNKNOWN: "unknown",
            }[s.callStatus] === filterStatus),
      );
    batches.push(batch);
  }
  return { batches, models: await publicOptions(), page: p, hasMore: rows.length > 6 };
}
export async function listPelicanPublic(q: URLSearchParams): Promise<PelicanListing> {
  await ensureDatabaseReady();
  const page = pageNumber(q.get("page"));
  const modelKey = q.get("modelKey")?.trim() || q.get("model")?.trim() || null;
  const batchId = q.get("batchId")?.trim() || q.get("batch")?.trim() || null;
  const rows = (
    await getPool().query(
      `SELECT b.* FROM pelican_batches b WHERE b.status='PUBLISHED' AND ($1::text IS NULL OR EXISTS(SELECT 1 FROM pelican_samples s WHERE s.batch_id=b.id AND s.model_key=$1 AND s.withdrawn_at IS NULL)) AND ($2::text IS NULL OR b.id=$2) ORDER BY b.published_at DESC,b.id DESC LIMIT 7 OFFSET $3`,
      [modelKey, batchId, (page - 1) * 6],
    )
  ).rows;
  const models = (
    await getPool().query(
      `SELECT DISTINCT s.model_key key,s.model_name name FROM pelican_samples s JOIN pelican_batches b ON b.id=s.batch_id WHERE b.status='PUBLISHED' AND s.withdrawn_at IS NULL ORDER BY s.model_name,s.model_key`,
    )
  ).rows as { key: string; name: string }[];
  const batches: PelicanBatch[] = [];
  for (const row of rows.slice(0, 6)) {
    const samples = await sampleRows(row.id);
    const visible = (modelKey ? samples.filter((s) => s.model_key === modelKey) : samples).filter(
      (s) => !s.withdrawn_at,
    );
    if (!visible.length) continue;
    batches.push(batchDto(row, visible));
  }
  return { batches, models, page, hasMore: rows.length > 6 };
}
export async function getPelicanAccessibleSample(id: string): Promise<QueryResultRow> {
  await ensureDatabaseReady();
  const row = (
    await getPool().query(
      `SELECT s.*,b.status batch_status,b.owner_user_id FROM pelican_effective_samples s JOIN pelican_batches b ON b.id=s.batch_id WHERE s.id=$1`,
      [id],
    )
  ).rows[0];
  if (!row) throw new AccountError("PELICAN_SAMPLE_NOT_FOUND", 404);
  if (row.withdrawn_at) throw new AccountError("PELICAN_SAMPLE_NOT_FOUND", 404);
  if (row.batch_status !== "PUBLISHED") {
    try {
      await requireActivePelicanAdmin();
    } catch {
      throw new AccountError("PELICAN_SAMPLE_NOT_FOUND", 404);
    }
  }
  return row;
}
export async function publishPelicanBatch(id: string): Promise<PelicanAdminBatch> {
  await requireActivePelicanAdmin();
  await withTransaction(async (c) => {
    await requireActivePelicanAdmin(c);
    const row = (await c.query("SELECT * FROM pelican_batches WHERE id=$1 FOR UPDATE", [id]))
      .rows[0];
    if (!row) throw new AccountError("PELICAN_BATCH_NOT_FOUND", 404);
    if (row.status === "PUBLISHED") return;
    if (!["DRAFT", "COMPLETE", "WITHDRAWN"].includes(row.status) || !publishable(await sampleRows(id, c, true)))
      throw new AccountError("PELICAN_NOT_PUBLISHABLE", 409);
    if (row.status === "WITHDRAWN") {
      // Re-publication keeps the original published_at and clears the withdrawal audit.
      await c.query(
        "UPDATE pelican_batches SET status='PUBLISHED',withdrawn_at=NULL,withdrawal_reason=NULL WHERE id=$1",
        [id],
      );
    } else {
      await c.query(
        "UPDATE pelican_batches SET status='PUBLISHED',published_at=clock_timestamp() WHERE id=$1",
        [id],
      );
    }
  });
  return getPelicanAdminBatch(id);
}
function cleanWithdrawalReason(reason: unknown): string {
  if (
    typeof reason !== "string" ||
    !reason.trim() ||
    reason.length > 500 ||
    /[\u0000-\u001f]/.test(reason)
  )
    throw new AccountError("INVALID_WITHDRAWAL_REASON");
  return reason.trim();
}
export async function withdrawPelicanSample(
  batchId: string,
  sampleId: string,
  reason: unknown,
): Promise<PelicanAdminBatch> {
  const actor = await requireActivePelicanAdmin();
  const clean = cleanWithdrawalReason(reason);
  await withTransaction(async (c) => {
    await requireActivePelicanAdmin(c);
    const batch = (await c.query("SELECT * FROM pelican_batches WHERE id=$1 FOR UPDATE", [batchId]))
      .rows[0];
    if (!batch || batch.owner_user_id !== actor.id)
      throw new AccountError("PELICAN_BATCH_NOT_FOUND", 404);
    if (batch.status !== "PUBLISHED") throw new AccountError("PELICAN_NOT_PUBLISHED", 409);
    const sample = (
      await c.query(
        "SELECT id,withdrawn_at FROM pelican_samples WHERE id=$1 AND batch_id=$2 FOR UPDATE",
        [sampleId, batchId],
      )
    ).rows[0];
    if (!sample) throw new AccountError("PELICAN_SAMPLE_NOT_FOUND", 404);
    if (sample.withdrawn_at) return;
    await c.query(
      "UPDATE pelican_samples SET withdrawn_at=clock_timestamp(),withdrawn_reason=$2,withdrawn_by=$3 WHERE id=$1",
      [sampleId, clean, actor.id],
    );
  });
  return getPelicanAdminBatch(batchId);
}
export async function restorePelicanSample(
  batchId: string,
  sampleId: string,
): Promise<PelicanAdminBatch> {
  const actor = await requireActivePelicanAdmin();
  await withTransaction(async (c) => {
    await requireActivePelicanAdmin(c);
    const batch = (await c.query("SELECT * FROM pelican_batches WHERE id=$1 FOR UPDATE", [batchId]))
      .rows[0];
    if (!batch || batch.owner_user_id !== actor.id)
      throw new AccountError("PELICAN_BATCH_NOT_FOUND", 404);
    if (batch.status !== "PUBLISHED") throw new AccountError("PELICAN_NOT_PUBLISHED", 409);
    const sample = (
      await c.query(
        "SELECT id FROM pelican_samples WHERE id=$1 AND batch_id=$2 FOR UPDATE",
        [sampleId, batchId],
      )
    ).rows[0];
    if (!sample) throw new AccountError("PELICAN_SAMPLE_NOT_FOUND", 404);
    await c.query(
      "UPDATE pelican_samples SET withdrawn_at=NULL,withdrawn_reason=NULL,withdrawn_by=NULL WHERE id=$1",
      [sampleId],
    );
  });
  return getPelicanAdminBatch(batchId);
}
export async function withdrawPelicanBatch(
  id: string,
  reason: unknown,
): Promise<PelicanAdminBatch> {
  await requireActivePelicanAdmin();
  const clean = cleanWithdrawalReason(reason);
  await withTransaction(async (c) => {
    await requireActivePelicanAdmin(c);
    const row = (await c.query("SELECT * FROM pelican_batches WHERE id=$1 FOR UPDATE", [id]))
      .rows[0];
    if (!row) throw new AccountError("PELICAN_BATCH_NOT_FOUND", 404);
    if (row.status === "WITHDRAWN") return;
    if (row.status !== "PUBLISHED") throw new AccountError("PELICAN_NOT_PUBLISHED", 409);
    await c.query(
      "UPDATE pelican_batches SET status='WITHDRAWN',withdrawn_at=clock_timestamp(),withdrawal_reason=$2 WHERE id=$1",
      [id, clean],
    );
  });
  return getPelicanAdminBatch(id);
}
export async function rerunPelicanSample(
  batchId: string,
  sampleId: string,
  requestKey: unknown,
): Promise<PelicanAdminBatch> {
  await requireActivePelicanAdmin();
  if (typeof requestKey !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(requestKey))
    throw new AccountError("INVALID_REQUEST_KEY");
  await withTransaction(async (c) => {
    await requireActivePelicanAdmin(c);
    const batch = (await c.query("SELECT * FROM pelican_batches WHERE id=$1 FOR UPDATE", [batchId]))
      .rows[0];
    if (!batch) throw new AccountError("PELICAN_BATCH_NOT_FOUND", 404);
    const previous = (
      await c.query("SELECT * FROM pelican_samples WHERE batch_id=$1 AND rerun_request_key=$2", [
        batchId,
        requestKey,
      ])
    ).rows[0];
    if (previous) {
      if (previous.rerun_of !== sampleId) throw new AccountError("PELICAN_REQUEST_CONFLICT", 409);
      return;
    }
    if (!["DRAFT", "COMPLETE"].includes(batch.status))
      throw new AccountError("PELICAN_NOT_RERUNNABLE", 409);
    const samples = await sampleRows(batchId, c),
      sample = samples.find((s) => s.id === sampleId);
    if (
      !sample ||
      !["FAILED", "SUCCEEDED"].includes(sample.execution_status) ||
      samples.some((s) => s.execution_status === "PENDING") ||
      !publishable([sample])
    )
      throw new AccountError("PELICAN_NOT_RERUNNABLE", 409);
    const ordinal = (
      await c.query(
        "SELECT COALESCE(MAX(ordinal),0)+1 ordinal FROM pelican_samples WHERE batch_id=$1",
        [batchId],
      )
    ).rows[0].ordinal;
    // Rebuild the frozen snapshot and request payload from the current environment and
    // delivery instruction so a rerun dispatches the same messages the reservation will
    // recompute (never a stale payload from an earlier policy version).
    const ceiling = pelicanModelOutputCeiling(process.env, sample.model_key);
    const rerunConfig = liveConfig({
      modelKey: sample.model_key,
      strength: sample.config_snapshot.strength,
      maxOutputTokens: ceiling,
    });
    await c.query(
      `INSERT INTO pelican_samples(id,batch_id,ordinal,model_key,model_name,config_snapshot,request_payload,rerun_of,rerun_request_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        `pelican_sample_${randomUUID()}`,
        batchId,
        ordinal,
        sample.model_key,
        sample.model_name,
        JSON.stringify(freezePelicanConfig(rerunConfig)),
        JSON.stringify(pelicanPayload(rerunConfig)),
        sampleId,
        requestKey,
      ],
    );
    await c.query("UPDATE pelican_batches SET status='DRAFT' WHERE id=$1", [batchId]);
  });
  return getPelicanAdminBatch(batchId);
}

export async function deleteFailedPelicanSample(batchId: string, sampleId: string) {
  const actor = await requireActivePelicanAdmin();
  await withTransaction(async (c) => {
    await requireActivePelicanAdmin(c);
    const batch = (await c.query("SELECT * FROM pelican_batches WHERE id=$1 FOR UPDATE", [batchId]))
      .rows[0];
    if (!batch || batch.owner_user_id !== actor.id)
      throw new AccountError("PELICAN_BATCH_NOT_FOUND", 404);
    if (!["DRAFT", "RUNNING", "COMPLETE"].includes(batch.status))
      throw new AccountError("PELICAN_BATCH_LOCKED", 409);
    const sample = (
      await c.query(
        "SELECT m.status FROM pelican_samples s LEFT JOIN model_executions m ON m.id=s.execution_id WHERE s.id=$1 AND s.batch_id=$2 FOR UPDATE OF s",
        [sampleId, batchId],
      )
    ).rows[0];
    if (!sample) throw new AccountError("PELICAN_SAMPLE_NOT_FOUND", 404);
    if (sample.status !== "FAILED") throw new AccountError("PELICAN_DELETE_NOT_ALLOWED", 409);
    await c.query(
      "INSERT INTO pelican_sample_deletions(sample_id,deleted_by) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [sampleId, actor.id],
    );
  });
  return getPelicanAdminBatch(batchId);
}
export async function deletePelicanBatch(batchId: string) {
  const actor = await requireActivePelicanAdmin();
  await withTransaction(async (c) => {
    await requireActivePelicanAdmin(c);
    const batch = (await c.query("SELECT * FROM pelican_batches WHERE id=$1 FOR UPDATE", [batchId]))
      .rows[0];
    if (!batch || batch.owner_user_id !== actor.id)
      throw new AccountError("PELICAN_BATCH_NOT_FOUND", 404);
    if (
      (await c.query("SELECT 1 FROM pelican_batch_deletions WHERE batch_id=$1", [batchId])).rowCount
    )
      return;
    if (
      (
        await c.query(
          "SELECT 1 FROM pelican_samples s JOIN model_executions m ON m.id=s.execution_id WHERE s.batch_id=$1 AND m.status='PENDING'",
          [batchId],
        )
      ).rowCount
    )
      throw new AccountError("PELICAN_BATCH_RUNNING", 409);
    await settlePelicanBatchStatus(batchId, c);
    const current = (await c.query("SELECT status FROM pelican_batches WHERE id=$1", [batchId]))
      .rows[0];
    if (!current || !["DRAFT", "COMPLETE"].includes(current.status))
      throw new AccountError("PELICAN_BATCH_LOCKED", 409);
    await c.query(
      "INSERT INTO pelican_batch_deletions(batch_id,deleted_by) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [batchId, actor.id],
    );
  });
  return getPelicanAdminBatch(batchId);
}
