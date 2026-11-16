import { describe, expect, it } from "vitest";
import { parseEvaluationHandoff, selectedEvaluationAdvice } from "./evaluation-handoff";

describe("evaluation suggestion handoff", () => {
  it("accepts only report identity and one to three distinct suggestion indexes", () => {
    expect(parseEvaluationHandoff({ reportId: "mex_report", indexes: [0, 1] })).toEqual({
      reportId: "mex_report",
      indexes: [0, 1],
    });
    for (const value of [
      null,
      { reportId: "r", indexes: [] },
      { reportId: "r", indexes: [0, 0] },
      { reportId: "r", indexes: [3] },
      { reportId: "r", indexes: [0], text: "forged advice" },
    ])
      expect(() => parseEvaluationHandoff(value)).toThrow();
  });
  it("rejects report indexes missing from the stored report", () => {
    expect(() => selectedEvaluationAdvice({ suggestions: [] }, [0])).toThrow();
    const suggestions = [
      { issue: "Clear goal", replacement: "State the goal", rationale: "It is ambiguous" },
    ];
    expect(selectedEvaluationAdvice({ suggestions }, [0])).toContain("State the goal");
    expect(selectedEvaluationAdvice({ suggestions }, [0])).toContain("preserve");
  });
});
