export type AvailabilityBudget = {
  enabled: boolean;
  frozen: boolean;
  unlimited: boolean;
  remainingTokens: number;
  remainingCostUsd: number;
  periodRemainingTokens: number;
  periodRemainingCostUsd: number;
  platform: {
    dailyLimitUsd: number;
    dailyUsedUsd: number;
    periodLimitUsd: number;
    periodUsedUsd: number;
  };
};
// A lower-bound check can prove a request impossible, but cannot prove that
// its final input, retry envelope or Skill stages fit. Dispatch remains authoritative.
export function modelAvailability(
  budget: AvailabilityBudget,
  minimumTokens: number,
  minimumUsd: number,
) {
  if (!budget.enabled) return "disabled" as const;
  if (budget.frozen) return "frozen" as const;
  if (budget.unlimited) return "ready" as const;
  if (minimumTokens > budget.remainingTokens || minimumUsd > budget.remainingCostUsd)
    return "daily" as const;
  if (minimumTokens > budget.periodRemainingTokens || minimumUsd > budget.periodRemainingCostUsd)
    return "period" as const;
  if (
    minimumUsd > budget.platform.dailyLimitUsd - budget.platform.dailyUsedUsd ||
    minimumUsd > budget.platform.periodLimitUsd - budget.platform.periodUsedUsd
  )
    return "platform" as const;
  return "ready" as const;
}
