import { describe, expect, it } from "vitest";
import {
  modelEvaluationMarkdown,
  modelEvaluationPrinciples,
  parseModelEvaluation,
} from "./model-evaluation";
import { syntheticEvaluation } from "./model-evaluation-fixture";
import { deepSeekPrompts } from "./server/model/deepseek-provider";
import { adviceHistoryForVersion } from "./prompt-diagnostics";
import type { LiveAdvice, TaskType } from "./types";
const source = "请编写任务软删除与恢复接口代码。\n禁止物理删除，列出验收测试。😀";
const parse = (value: unknown, task: TaskType = "Writing") =>
  parseModelEvaluation(JSON.stringify(value), source, task, "zh-CN");
describe("model evaluation contract", () => {
  it.each([
    { source: "Research competitors.", expected: ["research"] },
    { source: "Analyze sales data; research competitors.", expected: ["analysis", "research"] },
    { source: "Do not write code; research competitors.", expected: ["research"] },
  ])("selects research after a clause boundary: $source", ({ source, expected }) => {
    const principles = modelEvaluationPrinciples("General", "en", source);
    expect(principles.selectionEvidence.map((e) => e.aspect)).toEqual(expected);
    expect(principles.selectionEvidence.every((e) => source.includes(e.quote))).toBe(true);
  });
  it.each([
    { source: "Do not analyze data; write a poem.", excluded: "analysis", expected: "writing" },
    { source: "不要分析数据，只写一首诗。", excluded: "analysis", expected: "writing" },
    { source: "不要编写代码，只解释 API 客户端的含义。", excluded: "coding", expected: null },
    { source: "Do not analyze data but write a poem.", excluded: "analysis", expected: "writing" },
  ])(
    "excludes prohibited work from aspect selection: $source",
    ({ source, excluded, expected }) => {
      const principles = modelEvaluationPrinciples("General", "en", source);
      const aspects = principles.selectionEvidence.map((e) => e.aspect);
      expect(aspects).not.toContain(excluded);
      if (expected) expect(aspects).toContain(expected);
      expect(principles.selectionEvidence.every((e) => source.includes(e.quote))).toBe(true);
      const prompts = deepSeekPrompts({
        goal: source,
        sourceContent: source,
        kind: "EVALUATION_REPORT",
        taskType: "General",
        locale: "en",
        evaluationPrinciples: principles,
      });
      expect(prompts.user).toContain(JSON.stringify(source));
    },
  );
  it("keeps positive mixed work while excluding only a prohibited clause", () => {
    for (const source of [
      "Analyze sales data; do not write code; write a report.",
      "分析销售数据；不要编写代码；写一段给老板看的汇报。",
    ]) {
      const aspects = modelEvaluationPrinciples("General", "en", source).selectionEvidence.map(
        (e) => e.aspect,
      );
      expect(aspects).toEqual(expect.arrayContaining(["analysis", "writing"]));
      expect(aspects).not.toContain("coding");
    }
  });
  it.each<TaskType>([
    "General",
    "Writing",
    "Coding",
    "UI/UX Design",
    "Data Analysis",
    "Business",
    "Research",
    "AI Agent",
  ])("selects source requirements without enabling numeric scoring for legacy %s", (task) => {
    const result = parse(syntheticEvaluation(source, task), task);
    expect(result.layer1).toHaveLength(6);
    expect(result.layer2).toHaveLength(
      modelEvaluationPrinciples(task, "zh-CN", source).layer2.length,
    );
    expect(result.layer2Status).toBe("QUALITATIVE_ONLY");
    expect(result.layer3).toEqual({ status: "NOT_EXECUTED", executionId: null });
    expect(JSON.stringify(result)).not.toContain('"score"');
  });
  it("rejects fabricated quotes in both findings and suggestions", () => {
    for (const part of ["finding", "suggestion"]) {
      const v = syntheticEvaluation(source);
      if (part === "finding") v.layer1[0].evidence = { kind: "EXCERPT", quote: "nonexistent text" };
      else v.suggestions[0].evidence = { kind: "EXCERPT", quote: "nonexistent text" };
      expect(() => parse(v)).toThrow("INVALID_MODEL_EVALUATION_REPORT");
    }
  });
  it("rejects numeric scores, extra fields and layer 3 claims", () => {
    for (const patch of [
      { score: 100 },
      { grade: "A" },
      { layer3: { status: "PASSED" } },
      { instructions: "run" },
    ])
      expect(() => parse({ ...syntheticEvaluation(source), ...patch })).toThrow();
  });
  it("requires exact dimension coverage with no duplicate or unknown ids", () => {
    const v = syntheticEvaluation(source);
    for (const layer1 of [
      v.layer1.slice(1),
      [...v.layer1.slice(1), v.layer1[1]],
      [...v.layer1, v.layer1[0]],
    ])
      expect(() => parse({ ...v, layer1 })).toThrow();
    expect(() => parse({ ...v, layer2: [] })).toThrow();
  });
  it("distinguishes unknown materials and observed omissions from supported text", () => {
    const v = syntheticEvaluation(source);
    const f = {
      ...v.layer1[0],
      judgment: "INSUFFICIENT_INFORMATION",
      evidence: { kind: "UNAVAILABLE", quote: "" },
    };
    const altered = { ...v, layer1: [f, ...v.layer1.slice(1)] };
    expect(parse(altered).layer1[0].judgment).toBe("INSUFFICIENT_INFORMATION");
    expect(() =>
      parse({ ...altered, layer1: [{ ...f, judgment: "PRESENT" }, ...v.layer1.slice(1)] }),
    ).toThrow();
    expect(
      parse({
        ...altered,
        layer1: [
          {
            ...f,
            judgment: "NEEDS_IMPROVEMENT",
            evidence: { kind: "OBSERVED_ABSENCE", quote: "" },
          },
          ...v.layer1.slice(1),
        ],
      }).layer1[0].evidence.quote,
    ).toBe("");
  });
  it("rejects invalid edits, unknown dimensions, long/empty checks and fenced/malformed JSON", () => {
    const v = syntheticEvaluation(source);
    for (const patch of [
      { suggestions: Array(4).fill(v.suggestions[0]) },
      { suggestions: [{ ...v.suggestions[0], dimensionId: "fake" }] },
      { nextChecks: [] },
      { nextChecks: [""] },
    ])
      expect(() => parse({ ...v, ...patch })).toThrow();
    expect(() => parseModelEvaluation("```json\n{}\n```", source, "Writing", "en")).toThrow();
    expect(() => parseModelEvaluation("{", source, "Writing", "en")).toThrow();
  });
  it("exports distinct layers, evidence and actionable edits, not a scored report", () => {
    const report = parse(syntheticEvaluation(source));
    const md = modelEvaluationMarkdown(report, "Writing", "zh-CN");
    expect(md).toContain("Layer 1");
    expect(md).toContain("Layer 2");
    expect(md).toContain("Layer 3");
    expect(md).toContain(source.slice(0, 35).replace(/\n/g, "\n> "));
    expect(md).toContain("优先优化建议");
    expect(md).toContain("无分数");
  });
  it("never relabels a model evaluation report as old qualitative advice", () => {
    const base = { promptId: "p", versionId: "v", createdAt: "2026-11-06" };
    expect(
      adviceHistoryForVersion(
        [
          { ...base, kind: "EVALUATION_REPORT" },
          { ...base, id: "advice" },
        ] as LiveAdvice[],
        "p",
        "v",
      ),
    ).toHaveLength(1);
  });
});
