import { describe, expect, it } from "vitest";
import {
  calculateUsageCostUsd,
  estimatePromptTokens,
  estimateReservedCostUsd,
  resolvePricingWindow,
  roundCostUp,
  type ModelPricingSnapshot,
} from "./model-pricing";

const price: ModelPricingSnapshot = {
  id: "test-price",
  pricingWindow: "PEAK",
  inputCacheHitUsdPerMillion: 0.006,
  inputCacheMissUsdPerMillion: 0.3,
  outputUsdPerMillion: 1.2,
  sourceUrl: "test",
};
describe("local cost calculation (not provider billing)", () => {
  it("reserves AUTO at peak rather than guessing holidays", () => {
    expect(resolvePricingWindow("AUTO")).toBe("PEAK");
    expect(resolvePricingWindow("OFF_PEAK")).toBe("OFF_PEAK");
  });
  it("uses UTF-8 bytes plus framing for the input envelope", () => {
    expect(estimatePromptTokens("中文")).toBe(262);
    expect(estimatePromptTokens("abc")).toBe(259);
  });
  it("reserves cache-miss input and maximum output", () => {
    expect(estimateReservedCostUsd(price, 1000000, 1000000)).toBe(1.5);
  });
  it("prices hit, miss and output independently", () => {
    expect(
      calculateUsageCostUsd(price, {
        promptTokens: 1000000,
        completionTokens: 1000000,
        totalTokens: 2000000,
        promptCacheHitTokens: 500000,
        promptCacheMissTokens: 500000,
      }),
    ).toBe(1.353);
  });
  it("infers a single missing cache field; absent statistics mean all miss", () => {
    const usage = { promptTokens: 1000000, completionTokens: 0, totalTokens: 1000000 };
    expect(calculateUsageCostUsd(price, usage)).toBe(0.3);
    expect(calculateUsageCostUsd(price, { ...usage, promptCacheHitTokens: 500000 })).toBe(0.153);
    expect(calculateUsageCostUsd(price, { ...usage, promptCacheMissTokens: 500000 })).toBe(0.153);
  });
  it("rejects inconsistent or fractional measured usage", () => {
    expect(() =>
      calculateUsageCostUsd(price, { promptTokens: 10, completionTokens: 2, totalTokens: 13 }),
    ).toThrow();
    expect(() =>
      calculateUsageCostUsd(price, { promptTokens: 10.5, completionTokens: 0, totalTokens: 10.5 }),
    ).toThrow();
    expect(() =>
      calculateUsageCostUsd(price, {
        promptTokens: 10,
        completionTokens: 0,
        totalTokens: 10,
        promptCacheHitTokens: 11,
      }),
    ).toThrow();
  });
  it("rounds tiny nonzero cost upward to the ledger precision", () => {
    expect(roundCostUp(0.000000001)).toBe(0.00000001);
    expect(roundCostUp(0)).toBe(0);
  });
});
