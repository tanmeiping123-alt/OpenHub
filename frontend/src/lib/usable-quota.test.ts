import { describe, expect, it } from "vitest";
import { FREE_PLAN, PRO_PLAN } from "./billing-policy";
import { readQuotaDefaults } from "./server/model/model-config";
import { estimateReservedCostUsd } from "./server/model/model-pricing";

describe("finite plans support maximum-output short tasks", () => {
  const tokens = (20000 + 393216) * 3;
  const cost =
    estimateReservedCostUsd(
      {
        id: "local-peak",
        pricingWindow: "PEAK",
        inputCacheHitUsdPerMillion: 0.03,
        inputCacheMissUsdPerMillion: 0.3,
        outputUsdPerMillion: 1.2,
        sourceUrl: "local-snapshot",
      },
      20000,
      393216,
    ) * 3;
  it("Free can reserve one full request and Pro can reserve three", () => {
    expect(FREE_PLAN.dailyTokens).toBeGreaterThanOrEqual(tokens);
    expect(FREE_PLAN.dailyUsd).toBeGreaterThanOrEqual(cost);
    expect(PRO_PLAN.dailyTokens).toBeGreaterThanOrEqual(tokens * 3);
    expect(PRO_PLAN.dailyUsd).toBeGreaterThanOrEqual(cost * 3);
    expect(PRO_PLAN.amountFen).toBe(1);
    expect(PRO_PLAN.durationDays).toBe(30);
  });
  it("runtime defaults allow the plans, while explicit operator limits remain effective", () => {
    expect(readQuotaDefaults({}).dailyTokenLimit).toBeGreaterThanOrEqual(PRO_PLAN.dailyTokens);
    expect(readQuotaDefaults({}).dailyCostLimitUsd).toBeGreaterThanOrEqual(PRO_PLAN.dailyUsd);
    expect(
      readQuotaDefaults({
        PROMPTMASTER_MODEL_DAILY_TOKEN_LIMIT: "1000",
        PROMPTMASTER_MODEL_DAILY_COST_LIMIT_USD: "0",
      }),
    ).toMatchObject({ dailyTokenLimit: 1000, dailyCostLimitUsd: 0 });
  });
});
