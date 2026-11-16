import assert from "node:assert/strict";

export const experiment = Object.freeze({
  id: "soft-delete-skill-ab-20261105-01",
  ownerEmail: "1540744366@qq.com",
  skillVersionId: "skv_53d62c16-ef29-45d1-a1e0-0cec45628055",
  commit: "22f0b463e7a5e579904dd6211a520321035526f7",
  manifest: "2dfd3e4a45c621a9f99588071548b88a45c042a33140d12131adf4e846e3823b",
  goal: "为 Next.js + PostgreSQL 待办应用的“任务软删除与恢复”编写一份供工程师使用的中文实施规划 Prompt。必须覆盖登录用户仅能删除或恢复自己的任务、默认列表隐藏已删除任务、回收站恢复、数据迁移、接口与前端、删除/恢复/重复请求边界、测试、回滚及验收。实际仓库路径和版本未知，用待核对占位，不虚构现有实现或已执行测试；只产出可复用 Prompt，不执行开发。保持紧凑，避免重复说明。",
  baseline:
    "请为 Next.js + PostgreSQL 待办应用制定任务软删除与恢复的实施计划。任务归属于登录用户；用户只能删除或恢复自己的任务，删除后默认列表不可见，可从回收站恢复。列出数据迁移、接口、前端、测试、回滚和验收；未知仓库文件名须标记待核对，不要声称执行过测试。",
  maxRequests: 4,
  maxOutputTokens: 1200,
  maxRetries: 0,
  maxEnvelopeTokens: 60000,
  maxEstimatedUsd: 0.05,
});
export const roundUp = (value) => Number((Math.ceil(value * 100_000_000) / 100_000_000).toFixed(8));
export function serializePersistedContext(planRow, material) {
  assert.ok(planRow && planRow.analysis && Array.isArray(planRow.selections));
  assert.ok(Array.isArray(material) && material.every((item) => typeof item === "string"));
  assert.equal(material.length, planRow.selections.length);
  return JSON.stringify({ task: planRow.analysis, selections: planRow.selections, material });
}
export function reserveFor(serializedPrompts, pricing) {
  const promptTokens = Buffer.byteLength(serializedPrompts, "utf8") + 256;
  return {
    promptTokens,
    tokens: promptTokens + experiment.maxOutputTokens,
    usd: roundUp(
      (promptTokens * Number(pricing.input_cache_miss_usd_per_million) +
        experiment.maxOutputTokens * Number(pricing.output_usd_per_million)) /
        1_000_000,
    ),
  };
}
export function guardBudget(requests, tokens, usd) {
  assert.ok(
    Number.isSafeInteger(requests) && requests >= 0 && requests <= experiment.maxRequests,
    "EXPERIMENT_REQUEST_CAP",
  );
  assert.ok(
    Number.isSafeInteger(tokens) && tokens >= 0 && tokens <= experiment.maxEnvelopeTokens,
    "EXPERIMENT_TOKEN_CAP",
  );
  assert.ok(
    Number.isFinite(usd) && usd >= 0 && roundUp(usd) <= experiment.maxEstimatedUsd,
    "EXPERIMENT_USD_CAP",
  );
}
export function guardCompletion(row) {
  assert.equal(row.status, "SUCCEEDED", "MODEL_FAILED_STOP_NO_RETRY");
  assert.equal(row.max_attempts, 1, "SERVER_RETRIES_NOT_DISABLED");
  assert.equal(row.provider_attempt_count, 1, "UNEXPECTED_PROVIDER_ATTEMPT_COUNT");
  assert.equal(row.quota_reservation_status, "SETTLED", "USAGE_UNKNOWN_STOP");
  assert.ok(
    Number.isSafeInteger(row.prompt_tokens) && row.prompt_tokens >= 0,
    "PROMPT_USAGE_UNKNOWN",
  );
  assert.ok(
    Number.isSafeInteger(row.completion_tokens) &&
      row.completion_tokens >= 0 &&
      row.completion_tokens <= experiment.maxOutputTokens,
    "OUTPUT_USAGE_INVALID",
  );
  assert.equal(row.total_tokens, row.prompt_tokens + row.completion_tokens, "USAGE_INCONSISTENT");
  assert.ok(
    row.calculated_cost_usd !== null &&
      row.calculated_cost_usd !== undefined &&
      Number.isFinite(Number(row.calculated_cost_usd)) &&
      Number(row.calculated_cost_usd) >= 0,
    "COST_UNKNOWN_STOP",
  );
  assert.equal(
    row.finish_reason,
    "stop",
    row.finish_reason === "length"
      ? "MODEL_TRUNCATED_STOP_NO_TOP_UP"
      : "FINISH_REASON_NOT_ACCEPTED",
  );
}
