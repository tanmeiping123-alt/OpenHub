import { describe, expect, it } from "vitest";
import { describeModePolicy, MODE_POLICIES } from "./mode-policy";

describe("approved mode defaults (not a matcher)", () => {
  it("keeps skill count task-driven in both modes", () => {
    expect(MODE_POLICIES.simple).toEqual({
      defaultMatchingMode: "AUTO",
      skillCountPolicy: "TASK_DRIVEN",
    });
    expect(MODE_POLICIES.professional).toEqual({
      defaultMatchingMode: "HYBRID",
      skillCountPolicy: "TASK_DRIVEN",
    });
    expect(Object.isFrozen(MODE_POLICIES)).toBe(true);
    expect(Object.values(MODE_POLICIES).every(Object.isFrozen)).toBe(true);
  });

  it.each(["simple", "professional"] as const)(
    "discloses bounded matching and no implicit authority for %s",
    (mode) => {
      expect(describeModePolicy(mode, "en")).toContain("deterministic analysis and matching");
      expect(describeModePolicy(mode, "en")).toContain("grants no import");
      expect(describeModePolicy(mode, "zh-CN")).toContain("共用确定性任务分析和匹配");
      expect(describeModePolicy(mode, "zh-CN")).toContain("不会授权导入");
    },
  );
});
