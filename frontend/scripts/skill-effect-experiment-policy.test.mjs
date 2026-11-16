import assert from "node:assert/strict";
import test from "node:test";
import {
  experiment,
  reserveFor,
  guardBudget,
  guardCompletion,
  serializePersistedContext,
} from "./skill-effect-experiment-policy.mjs";

const pricing = { input_cache_miss_usd_per_million: "0.30", output_usd_per_million: "1.20" };
test("input bytes use persisted JSONB order rather than create-plan response order", () => {
  const http = { goal: "任务", bounds: { skills: 4 }, locale: "zh-CN" };
  const persisted = { goal: "任务", locale: "zh-CN", bounds: { skills: 4 } };
  assert.deepEqual(http, persisted);
  assert.notEqual(JSON.stringify(http), JSON.stringify(persisted));
  const row = { analysis: persisted, selections: [] };
  assert.equal(
    serializePersistedContext(row, []),
    JSON.stringify({ task: persisted, selections: [], material: [] }),
  );
  assert.throws(() => serializePersistedContext(row, ["unexpected material"]));
});
const success = {
  status: "SUCCEEDED",
  max_attempts: 1,
  provider_attempt_count: 1,
  quota_reservation_status: "SETTLED",
  prompt_tokens: 50,
  completion_tokens: 1200,
  total_tokens: 1250,
  calculated_cost_usd: "0.00145500",
  finish_reason: "stop",
};
test("approved budget boundaries pass, over-limit and malformed values fail", () => {
  guardBudget(4, 60000, 0.05);
  for (const args of [
    [5, 1, 0],
    [1, 60001, 0],
    [1, 1, 0.05000001],
    [1, -1, 0],
    [1, 1, NaN],
    [1.5, 1, 0],
  ])
    assert.throws(() => guardBudget(...args));
});
test("UTF-8 byte envelope and maximum output are reserved at cache-miss pricing", () => {
  const value = JSON.stringify({ user: "软删除" });
  const result = reserveFor(value, pricing);
  assert.equal(result.tokens, Buffer.byteLength(value) + 256 + 1200);
  assert.ok(result.usd > 0);
  assert.equal(experiment.maxRetries, 0);
});
test("truncation or any unknown/failed/retried usage stops instead of topping up", () => {
  guardCompletion(success);
  for (const patch of [
    { finish_reason: "length" },
    { finish_reason: null },
    { status: "FAILED" },
    { max_attempts: 3 },
    { provider_attempt_count: 2 },
    { quota_reservation_status: "HELD" },
    { total_tokens: 1251 },
    { completion_tokens: 1201 },
    { calculated_cost_usd: null },
  ])
    assert.throws(() => guardCompletion({ ...success, ...patch }));
});
