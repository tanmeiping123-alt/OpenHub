import type { ModelUsage } from "./model-types";

export type PricingWindow = "OFF_PEAK" | "PEAK";
export type ModelPricingSnapshot = {
  id: string;
  pricingWindow: PricingWindow;
  inputCacheHitUsdPerMillion: number;
  inputCacheMissUsdPerMillion: number;
  outputUsdPerMillion: number;
  sourceUrl: string;
};

// AUTO reserves at peak rates: the provider's holiday calendar and exact billing
// instant are not available locally. Discounts require provider reconciliation.
export function resolvePricingWindow(configured: "AUTO" | PricingWindow): PricingWindow {
  return configured === "AUTO" ? "PEAK" : configured;
}

export function estimatePromptTokens(serializedMessages: string) {
  // Conservative UTF-8 byte envelope including framing, not measured token usage.
  return new TextEncoder().encode(serializedMessages).length + 256;
}

export function estimateReservedCostUsd(
  snapshot: ModelPricingSnapshot,
  promptTokens: number,
  outputTokens: number,
) {
  return roundCostUp(
    (promptTokens * snapshot.inputCacheMissUsdPerMillion +
      outputTokens * snapshot.outputUsdPerMillion) /
      1_000_000,
  );
}

export function calculateUsageCostUsd(snapshot: ModelPricingSnapshot, usage: ModelUsage) {
  if (
    ![usage.promptTokens, usage.completionTokens, usage.totalTokens].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    usage.totalTokens !== usage.promptTokens + usage.completionTokens
  )
    throw new Error("Inconsistent provider token usage.");
  const hitTokens =
    usage.promptCacheHitTokens ??
    (usage.promptCacheMissTokens === undefined
      ? 0
      : usage.promptTokens - usage.promptCacheMissTokens);
  const missTokens = usage.promptCacheMissTokens ?? usage.promptTokens - hitTokens;
  if (
    !Number.isSafeInteger(hitTokens) ||
    !Number.isSafeInteger(missTokens) ||
    hitTokens < 0 ||
    missTokens < 0 ||
    hitTokens + missTokens !== usage.promptTokens
  ) {
    throw new Error("Inconsistent provider cache usage.");
  }
  return roundCostUp(
    (hitTokens * snapshot.inputCacheHitUsdPerMillion +
      missTokens * snapshot.inputCacheMissUsdPerMillion +
      usage.completionTokens * snapshot.outputUsdPerMillion) /
      1_000_000,
  );
}

export function roundCostUp(value: number) {
  return Number((Math.ceil(value * 100_000_000) / 100_000_000).toFixed(8));
}
