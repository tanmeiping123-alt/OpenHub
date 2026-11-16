import { workspaceOwnerId } from "../identity-context";
import "server-only";
import type { PoolClient, QueryResultRow } from "pg";
import { withTransaction } from "../db";
import { initializeDemoData } from "../repository";
import { ModelServiceError } from "./model-errors";
import {
  calculateUsageCostUsd,
  estimatePromptTokens,
  estimateReservedCostUsd,
  resolvePricingWindow,
  roundCostUp,
  type ModelPricingSnapshot,
} from "./model-pricing";
import type { LiveModelConfig, ModelUsage } from "./model-types";
import { assertPromptCapacity, entitlement, lockQuota } from "../billing/entitlements";
import { periodUsage, platformBudget } from "../billing/quota-periods";
import { AccountError } from "../account-errors";

// Must fit the integer/numeric columns used by the reservation SQL.
const UNLIMITED_TOKEN_LIMIT = 2_147_483_647;
const UNLIMITED_COST_LIMIT_USD = 99_999_999;

function mapPricing(row: QueryResultRow): ModelPricingSnapshot {
  return {
    id: row.id,
    pricingWindow: row.pricing_window,
    inputCacheHitUsdPerMillion: Number(row.input_cache_hit_usd_per_million),
    inputCacheMissUsdPerMillion: Number(row.input_cache_miss_usd_per_million),
    outputUsdPerMillion: Number(row.output_usd_per_million),
    sourceUrl: row.source_url,
  };
}

async function policyFor(
  client: PoolClient,
  ownerId: string,
  config: LiveModelConfig,
  readOnly = false,
) {
  if (!readOnly)
    await client.query(
      `INSERT INTO model_quota_policies (owner_user_id, daily_token_limit, daily_cost_limit_usd)
     VALUES ($1, $2, $3) ON CONFLICT (owner_user_id) DO NOTHING`,
      [ownerId, config.dailyTokenLimit, config.dailyCostLimitUsd],
    );
  const { rows } = await client.query(
    `SELECT * FROM model_quota_policies WHERE owner_user_id = $1${readOnly ? "" : " FOR UPDATE"}`,
    [ownerId],
  );
  const row = rows[0] ?? {
    enabled: true,
    unlimited: false,
    daily_token_limit: config.dailyTokenLimit,
    daily_cost_limit_usd: config.dailyCostLimitUsd,
  };
  const access = await entitlement(client, ownerId);
  const unlimited = row.unlimited === true;
  const baseCostLimit = unlimited
    ? UNLIMITED_COST_LIMIT_USD
    : Math.min(Number(row.daily_cost_limit_usd), config.dailyCostLimitUsd, access.plan.dailyUsd);
  // An explicit approval replaces only the daily USD ceiling for this exact
  // paid subscription and UTC day. Never changes plans, tokens, usage or
  // period/platform guards. Zero ceilings remain an operational stop switch.
  const allowance =
    !unlimited && baseCostLimit > 0 && row.enabled && !access.frozen && access.orderId
      ? (
          await client.query(
            `SELECT id,daily_cost_limit_usd,expires_at FROM model_daily_cost_allowances
         WHERE owner_user_id=$1 AND order_id=$2
           AND usage_day=(clock_timestamp() AT TIME ZONE 'UTC')::date
           AND starts_at<=clock_timestamp() AND expires_at>clock_timestamp()`,
            [ownerId, access.orderId],
          )
        ).rows[0]
      : undefined;
  return {
    enabled: row.enabled,
    unlimited,
    tokenLimit: unlimited
      ? UNLIMITED_TOKEN_LIMIT
      : Math.min(row.daily_token_limit, config.dailyTokenLimit, access.plan.dailyTokens),
    costLimit: allowance
      ? Math.max(baseCostLimit, Number(allowance.daily_cost_limit_usd))
      : baseCostLimit,
    baseCostLimit,
    dailyCostAllowance: allowance
      ? {
          dailyCostLimitUsd: Number(allowance.daily_cost_limit_usd),
          expiresAt: new Date(allowance.expires_at).toISOString(),
        }
      : null,
    access,
  };
}

async function pricingFor(client: PoolClient, config: LiveModelConfig) {
  const { rows } = await client.query(
    `SELECT * FROM model_pricing_snapshots
     WHERE provider = $1 AND requested_model = $2 AND product_version = $3
       AND pricing_window = $4 AND effective_at <= now() AND valid_until > now()
     ORDER BY effective_at DESC, captured_at DESC, id DESC LIMIT 1`,
    [
      config.provider,
      config.model,
      config.productVersion,
      resolvePricingWindow(config.pricingWindow),
    ],
  );
  if (!rows[0])
    throw new ModelServiceError(
      "MODEL_PRICING_UNAVAILABLE",
      "The model pricing snapshot is missing or expired.",
      503,
    );
  return rows[0];
}

export async function reserveModelQuota(
  input: {
    executionId: string;
    config: LiveModelConfig;
    serializedMessages: string;
  },
  ownerId = workspaceOwnerId(),
) {
  return withTransaction((client) => reserveModelQuotaInTransaction(client, input, ownerId));
}
export async function reserveModelQuotaInTransaction(
  client: PoolClient,
  input: { executionId: string; config: LiveModelConfig; serializedMessages: string },
  ownerId: string,
) {
  const execution = await client.query(
    "SELECT * FROM model_executions WHERE id = $1 AND owner_user_id = $2 FOR UPDATE",
    [input.executionId, ownerId],
  );
  const row = execution.rows[0];
  if (
    !row ||
    row.status !== "PENDING" ||
    row.quota_reservation_status !== "NOT_RESERVED" ||
    row.provider !== input.config.provider ||
    row.requested_model !== input.config.model ||
    row.product_version !== input.config.productVersion
  ) {
    throw new ModelServiceError(
      "MODEL_EXECUTION_STATE_CONFLICT",
      "Execution cannot reserve quota.",
      409,
    );
  }
  await lockQuota(client);
  const policy = await policyFor(client, ownerId, input.config);
  if (!policy.enabled)
    throw new ModelServiceError(
      "MODEL_USER_DISABLED",
      "Live model access is disabled for this user.",
      403,
    );
  if (policy.access.frozen)
    throw new ModelServiceError(
      "MODEL_REFUND_PENDING",
      "New model calls are paused while this order's refund is being reviewed.",
      409,
    );
  if (row.purpose === "PROMPT_GENERATION") {
    try {
      await assertPromptCapacity(client, ownerId);
    } catch (error) {
      if (!(error instanceof AccountError)) throw error;
      throw new ModelServiceError(
        "PROMPT_CAPACITY_EXCEEDED",
        "Saved Prompt capacity is full. Existing objects and versions remain available.",
        429,
      );
    }
  }
  const pricing = mapPricing(await pricingFor(client, input.config));
  const promptTokens = estimatePromptTokens(input.serializedMessages);
  const outputEnvelope = input.config.maxOutputTokens + (input.config.reasoningTokenReserve ?? 0);
  const perAttemptTokens = promptTokens + outputEnvelope;
  const perAttemptCost = estimateReservedCostUsd(pricing, promptTokens, outputEnvelope);
  const maxAttempts = input.config.maxRetries + 1;
  const tokens = perAttemptTokens * maxAttempts;
  const cost = roundCostUp(perAttemptCost * maxAttempts);
  const cycle = await periodUsage(client, ownerId, policy.access);
  if (
    !policy.unlimited &&
    (cycle.settledTokens + cycle.reservedTokens + tokens > policy.access.plan.periodTokens ||
      roundCostUp(cycle.settledUsd + cycle.reservedUsd + cost) > policy.access.plan.periodUsd)
  )
    throw new ModelServiceError(
      "MODEL_PERIOD_QUOTA_EXCEEDED",
      `The 30-day token or estimated USD budget cannot cover this request; period ends ${policy.access.end.toISOString()}.`,
      429,
    );
  const platform = await platformBudget(client);
  if (
    !policy.unlimited &&
    (roundCostUp(platform.dailyUsedUsd + cost) > platform.dailyLimitUsd ||
      roundCostUp(platform.periodUsedUsd + cost) > platform.periodLimitUsd)
  )
    throw new ModelServiceError(
      "MODEL_PLATFORM_BUDGET_EXCEEDED",
      `The platform trial budget cannot cover this request. Daily budget resets at 00:00 UTC; platform period ends ${platform.periodEnd}.`,
      429,
    );
  const { rows: days } = await client.query(
    "SELECT to_char(timezone('UTC', now()), 'YYYY-MM-DD') AS usage_day_key",
  );
  const day = days[0].usage_day_key;
  await client.query(
    "INSERT INTO model_quota_usage_daily (owner_user_id, usage_day) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [ownerId, day],
  );
  const reserved = await client.query(
    `UPDATE model_quota_usage_daily
       SET reserved_tokens = reserved_tokens + $3, reserved_cost_usd = reserved_cost_usd + $4
       WHERE owner_user_id = $1 AND usage_day = $2
         AND settled_tokens + reserved_tokens + $3 <= $5
         AND settled_cost_usd + reserved_cost_usd + $4 <= $6 RETURNING owner_user_id`,
    [ownerId, day, tokens, cost, policy.tokenLimit, policy.costLimit],
  );
  if (!reserved.rowCount) {
    const u = (
      await client.query(
        "SELECT * FROM model_quota_usage_daily WHERE owner_user_id=$1 AND usage_day=$2",
        [ownerId, day],
      )
    ).rows[0];
    const reason =
      Number(u.settled_tokens) + Number(u.reserved_tokens) + tokens > policy.tokenLimit
        ? "token"
        : "local estimated USD cost";
    throw new ModelServiceError(
      "MODEL_USER_QUOTA_EXCEEDED",
      `The daily ${reason} budget cannot cover this request and its retry allowance. Daily reset: 00:00 UTC.`,
      429,
    );
  }
  await client.query(
    `UPDATE model_executions SET pricing_snapshot_id = $3, quota_usage_day = $4,
       reserved_total_tokens = $5, estimated_cost_usd = $6, per_attempt_tokens = $7,
       per_attempt_cost_usd = $8, max_attempts = $9, quota_reservation_status = 'RESERVED',
       quota_reserved_at=clock_timestamp(),quota_order_id=$10,quota_period_start=$11,quota_period_end=$12,quota_plan_snapshot=$13
       WHERE id = $1 AND owner_user_id = $2`,
    [
      input.executionId,
      ownerId,
      pricing.id,
      day,
      tokens,
      cost,
      perAttemptTokens,
      perAttemptCost,
      maxAttempts,
      policy.access.orderId,
      policy.access.start,
      policy.access.end,
      JSON.stringify(policy.access.plan),
    ],
  );
}

export async function markModelAttempt(executionId: string, ownerId = workspaceOwnerId()) {
  await withTransaction(async (client) => {
    const reserved = await client.query(
      "SELECT * FROM model_executions WHERE id=$1 AND owner_user_id=$2 FOR UPDATE",
      [executionId, ownerId],
    );
    if (reserved.rows[0]?.quota_order_id) {
      await lockQuota(client);
      if (
        (
          await client.query(
            "SELECT 1 FROM billing_refunds WHERE order_id=$1 AND status IN ('REQUESTED','PROCESSING','SUCCESS')",
            [reserved.rows[0].quota_order_id],
          )
        ).rowCount
      )
        throw new ModelServiceError(
          "MODEL_REFUND_PENDING",
          "New provider attempts are paused for this refunded or refunding order.",
          409,
        );
    }
    const updated = await client.query(
      `UPDATE model_executions SET provider_attempt_count = provider_attempt_count + 1
       WHERE id = $1 AND owner_user_id = $2 AND status = 'PENDING'
         AND quota_reservation_status = 'RESERVED' AND provider_attempt_count < max_attempts
       RETURNING id`,
      [executionId, ownerId],
    );
    if (!updated.rowCount)
      throw new ModelServiceError(
        "MODEL_EXECUTION_STATE_CONFLICT",
        "No reserved provider attempt is available.",
        409,
      );
  });
}

// Must run inside the same transaction as the final execution / core data write.
// Ambiguous attempts keep their reservation until operator reconciliation.
export async function finalizeModelQuota(
  client: PoolClient,
  executionId: string,
  ownerId: string,
  usage?: ModelUsage,
) {
  const { rows } = await client.query(
    "SELECT * FROM model_executions WHERE id = $1 AND owner_user_id = $2 FOR UPDATE",
    [executionId, ownerId],
  );
  const row = rows[0];
  if (!row || row.quota_reservation_status !== "RESERVED") return;
  await lockQuota(client);
  let cost = 0;
  if (usage) {
    const pricing = await client.query("SELECT * FROM model_pricing_snapshots WHERE id = $1", [
      row.pricing_snapshot_id,
    ]);
    cost = calculateUsageCostUsd(mapPricing(pricing.rows[0]), usage);
  }
  const unknownAttempts = Math.max(0, row.provider_attempt_count - (usage ? 1 : 0));
  const heldTokens = row.per_attempt_tokens * unknownAttempts;
  const heldCost = roundCostUp(Number(row.per_attempt_cost_usd) * unknownAttempts);
  await client.query(
    `UPDATE model_quota_usage_daily
     SET reserved_tokens = reserved_tokens - $3 + $4,
         reserved_cost_usd = reserved_cost_usd - $5 + $6,
         settled_tokens = settled_tokens + $7, settled_cost_usd = settled_cost_usd + $8,
         successful_executions = successful_executions + $9,
         failed_executions = failed_executions + $10
     WHERE owner_user_id = $1 AND usage_day = $2`,
    [
      ownerId,
      row.quota_usage_day,
      row.reserved_total_tokens,
      heldTokens,
      row.estimated_cost_usd,
      heldCost,
      usage?.totalTokens ?? 0,
      cost,
      row.status === "SUCCEEDED" ? 1 : 0,
      row.status === "FAILED" ? 1 : 0,
    ],
  );
  await client.query(
    `UPDATE model_executions SET reserved_total_tokens = $3, estimated_cost_usd = $4,
     calculated_cost_usd = $5, quota_reservation_status = $6, reconciliation_status = $7
     WHERE id = $1 AND owner_user_id = $2`,
    [
      executionId,
      ownerId,
      heldTokens,
      heldCost,
      usage ? cost : null,
      unknownAttempts ? "HELD" : usage ? "SETTLED" : "RELEASED",
      unknownAttempts ? "REQUIRED" : usage ? "PENDING_PROVIDER" : "NOT_REQUIRED",
    ],
  );
}

export async function getModelQuotaSummary(config: LiveModelConfig, readOnly = false) {
  if (!readOnly) await initializeDemoData();
  return withTransaction(async (client) => {
    if (!readOnly) await lockQuota(client);
    const policy = await policyFor(client, workspaceOwnerId(), config, readOnly);
    const unlimited = policy.unlimited;
    const cycle = await periodUsage(client, workspaceOwnerId(), policy.access);
    const platform = await platformBudget(client);
    const pricing = await pricingFor(client, config);
    const { rows: days } = await client.query(
      "SELECT to_char(timezone('UTC', now()), 'YYYY-MM-DD') AS usage_day_key",
    );
    const day = days[0].usage_day_key;
    const { rows } = await client.query(
      "SELECT * FROM model_quota_usage_daily WHERE owner_user_id = $1 AND usage_day = $2",
      [workspaceOwnerId(), day],
    );
    const u = rows[0];
    const reservedTokens = Number(u?.reserved_tokens ?? 0);
    const settledTokens = Number(u?.settled_tokens ?? 0);
    const reservedCostUsd = Number(u?.reserved_cost_usd ?? 0);
    const settledCostUsd = Number(u?.settled_cost_usd ?? 0);
    const pending = await client.query(
      `SELECT count(*)::int count FROM model_executions
       WHERE owner_user_id = $1 AND (reconciliation_status IN ('REQUIRED', 'PENDING_PROVIDER', 'DISCREPANCY')
         OR (pricing_snapshot_id IS NULL AND status = 'SUCCEEDED'))`,
      [workspaceOwnerId()],
    );
    return {
      scope: "USER" as const,
      tierCode: policy.access.code as "FREE_V1" | "PRO_TEST_30D_V1",
      unlimited,
      enabled: policy.enabled,
      usageDay: day,
      resetTimezone: "UTC" as const,
      dailyTokenLimit: unlimited ? UNLIMITED_TOKEN_LIMIT : policy.tokenLimit,
      reservedTokens,
      settledTokens,
      usedTokens: reservedTokens + settledTokens,
      remainingTokens: unlimited
        ? UNLIMITED_TOKEN_LIMIT
        : Math.max(0, policy.tokenLimit - reservedTokens - settledTokens),
      dailyCostLimitUsd: unlimited ? UNLIMITED_COST_LIMIT_USD : policy.costLimit,
      baseDailyCostLimitUsd: unlimited ? UNLIMITED_COST_LIMIT_USD : policy.baseCostLimit,
      dailyCostAllowance: policy.dailyCostAllowance,
      reservedCostUsd,
      settledCostUsd,
      usedCostUsd: roundCostUp(reservedCostUsd + settledCostUsd),
      remainingCostUsd: unlimited
        ? UNLIMITED_COST_LIMIT_USD
        : Math.max(0, policy.costLimit - reservedCostUsd - settledCostUsd),
      currency: "USD" as const,
      pricingWindow: pricing.pricing_window as "PEAK" | "OFF_PEAK",
      pricingSourceUrl: pricing.source_url,
      pricingModel: config.model,
      pricingProductVersion: config.productVersion,
      pricingVerifiedAt: new Date(pricing.effective_at).toISOString(),
      pricingValidUntil: new Date(pricing.valid_until).toISOString(),
      costBasis: "LOCAL_ESTIMATE" as const,
      pendingReconciliations: pending.rows[0].count,
      periodStart: policy.access.start.toISOString(),
      periodEnd: policy.access.end.toISOString(),
      periodTokenLimit: unlimited ? UNLIMITED_TOKEN_LIMIT : policy.access.plan.periodTokens,
      periodCostLimitUsd: unlimited ? UNLIMITED_COST_LIMIT_USD : policy.access.plan.periodUsd,
      periodSettledTokens: cycle.settledTokens,
      periodReservedTokens: cycle.reservedTokens,
      periodRemainingTokens: unlimited
        ? UNLIMITED_TOKEN_LIMIT
        : Math.max(0, policy.access.plan.periodTokens - cycle.settledTokens - cycle.reservedTokens),
      periodSettledCostUsd: cycle.settledUsd,
      periodReservedCostUsd: cycle.reservedUsd,
      periodRemainingCostUsd: unlimited
        ? UNLIMITED_COST_LIMIT_USD
        : Math.max(0, policy.access.plan.periodUsd - cycle.settledUsd - cycle.reservedUsd),
      frozen: policy.access.frozen,
      platform,
    };
  });
}
