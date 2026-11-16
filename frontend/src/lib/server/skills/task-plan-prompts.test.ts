import { describe, expect, it } from "vitest";
import { deepSeekPrompts } from "../model/deepseek-provider";

describe("workflow delivery without method references", () => {
  it("preserves historical Skill-wrapped optimization messages regardless of plan identity", () => {
    const input = {
      goal: "Retain 500 USD",
      taskType: "General" as const,
      locale: "en" as const,
      kind: "OPTIMIZATION" as const,
      sourceContent: "Original body",
      skillContext: "historical-context",
    };
    expect(deepSeekPrompts({ ...input, skillPlanId: "old-plan" })).toEqual(deepSeekPrompts(input));
  });
  it("keeps the user's optimization goal when no Skills are selected", () => {
    const result = deepSeekPrompts({
      goal: "Preserve 500 USD and return only JSON",
      taskType: "General",
      locale: "en",
      kind: "OPTIMIZATION",
      sourceContent: "Summarize the invoice",
      skillPlanId: "new-plan",
    });
    expect(result.user).toContain("Preserve 500 USD and return only JSON");
    expect(result.user).toContain("Summarize the invoice");
    expect(result.user).not.toContain("SKILL MATERIALS");
  });
  it("expresses an explicit package as task delivery, keeping source and goal intact", () => {
    const result = deepSeekPrompts({
      goal: "Create a schema and dependent client",
      taskType: "Coding",
      locale: "en",
      kind: "OPTIMIZATION",
      sourceContent: "Original prompt",
      skillPlanId: "new-plan",
      taskPlanContext: JSON.stringify({
        delivery: "PROMPT_PACKAGE",
        stages: [{ name: "Schema" }, { name: "Client", dependsOn: [0] }],
      }),
    });
    expect(result.user).toContain("TASK DELIVERY PLAN");
    expect(result.user).toContain("Original prompt");
    expect(result.user).toContain("Create a schema and dependent client");
    expect(result.user).not.toContain("SKILL MATERIALS");
  });
});
