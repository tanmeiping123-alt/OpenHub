import { describe, expect, it } from "vitest";
import { modelAvailability, type AvailabilityBudget } from "./model-availability";
const base: AvailabilityBudget = {
  enabled: true,
  frozen: false,
  unlimited: false,
  remainingTokens: 1500000,
  remainingCostUsd: 2,
  periodRemainingTokens: 6000000,
  periodRemainingCostUsd: 5,
  platform: { dailyLimitUsd: 2, dailyUsedUsd: 0, periodLimitUsd: 15, periodUsedUsd: 0 },
};
describe("availability lower-bound checks", () => {
  it("preserves disabled and refund freezes even for unlimited accounts", () => {
    expect(modelAvailability({ ...base, unlimited: true, enabled: false }, 1, 1)).toBe("disabled");
    expect(modelAvailability({ ...base, unlimited: true, frozen: true }, 1, 1)).toBe("frozen");
  });
  it("distinguishes daily, period and shared platform limits without mutating usage", () => {
    expect(modelAvailability({ ...base, remainingTokens: 3 }, 393216, 0.48)).toBe("daily");
    expect(modelAvailability({ ...base, periodRemainingCostUsd: 0.1 }, 393216, 0.48)).toBe(
      "period",
    );
    expect(
      modelAvailability(
        { ...base, platform: { ...base.platform, dailyUsedUsd: 1.9 } },
        393216,
        0.48,
      ),
    ).toBe("platform");
    expect(modelAvailability(base, 393216, 0.48)).toBe("ready");
    expect(base.remainingTokens).toBe(1500000);
  });
});
