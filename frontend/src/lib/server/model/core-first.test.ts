import { describe, expect, it, vi } from "vitest";
import { deepSeekPrompts, generateWithDeepSeek } from "./deepseek-provider";
import { prepareModelDispatch } from "./model-policy";
import { analyzeSkillTask, matchSkillCandidates } from "@/lib/skill-workflow";
import {
  modelEvaluationPrinciples,
  modelEvaluationMarkdown,
  parseModelEvaluation,
  legacyModelEvaluationPrinciples,
} from "@/lib/model-evaluation";
import { syntheticEvaluation } from "@/lib/model-evaluation-fixture";
import type { LiveModelConfig, ModelGenerateInput } from "./model-types";

const input: ModelGenerateInput = {
  goal: "Write one line. Keep 42 USD and {{name}}.",
  taskType: "Business",
  locale: "en",
};
const config: LiveModelConfig = {
  mode: "LIVE",
  provider: "deepseek",
  apiKey: "synthetic",
  baseUrl: "https://example.test",
  model: "synthetic",
  productVersion: "test",
  timeoutMs: 1000,
  maxRetries: 0,
  maxOutputTokens: 1200,
  dailyTokenLimit: 100000,
  dailyCostLimitUsd: 5,
  pricingWindow: "AUTO",
};

describe("core-first model policy", () => {
  it("preserves supplied requirements without imposing category, format, role or method templates", () => {
    const p = deepSeekPrompts(input);
    expect(p.user).toContain(input.goal);
    expect(p.user).not.toContain("Business");
    expect(p.system).toContain("answer length");
    expect(p.system).toContain("schema");
    expect(p.system).toContain("only when");
    expect(p.system).not.toContain("must clearly include");
    const optimized = deepSeekPrompts({
      ...input,
      kind: "OPTIMIZATION",
      sourceContent: input.goal,
    });
    expect(optimized.system).toContain("unchanged");
    expect(optimized.user).toContain(input.goal);
    expect(optimized.system).not.toContain("without commentary or code fences");
  });
  it("honors requested code fences during actual playground dispatch", async () => {
    const p = {
      ...input,
      kind: "PLAYGROUND" as const,
      sourceContent: "Return a fenced TypeScript example",
    };
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        model: "synthetic",
        choices: [{ message: { content: "```ts\n42\n```" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    await generateWithDeepSeek(config, p, { fetchImpl });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.messages[0].content).not.toContain("or use code fences");
    expect(body.messages[0].content).toContain("requested output format");
  });
  it("uses exactly the same messages for reservation evidence and dispatch, excluding descriptors", async () => {
    const dispatch = prepareModelDispatch(input, config);
    const tagged = prepareModelDispatch(
      { ...input, descriptor: { purposes: ["build"], tags: ["private-tag"] } },
      config,
    );
    expect(tagged).toEqual(dispatch);
    expect(dispatch.messagesSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(dispatch.inputSha256).not.toBe(
      prepareModelDispatch({ ...input, goal: "other" }, config).inputSha256,
    );
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        model: "synthetic",
        choices: [{ message: { content: "result" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    await generateWithDeepSeek(
      config,
      { ...input, goal: "do not rebuild" },
      { fetchImpl, messages: dispatch.messages },
    );
    expect(JSON.stringify(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).messages)).toBe(
      dispatch.serializedMessages,
    );
  });
  it.each([
    "请解释“实现”一词的英文含义，用一句话回答",
    "将以下材料概括为一句话：" + "实现、部署、验收。".repeat(100),
    'Explain the word "deploy" in one sentence.',
    'Summarize this text: "First generate a schema; then implement using the previous output."',
    'Write a story that says "split into three stages".',
    "Do not split into three stages; write one directly usable prompt.",
    "不要分三个阶段，只输出一份提示词。",
  ])("does not stage lexical or quoted material: %s", (goal) => {
    expect(analyzeSkillTask(goal, "Coding", "en").delivery).toBe("SINGLE_PROMPT");
  });
  it.each([
    "分三个阶段分别交付需求、实现和验收提示词",
    "First produce an API schema; then implement the client using the previous schema output.",
  ])("retains an explicit staged delivery or dependency", (goal) => {
    expect(analyzeSkillTask(goal, "General", "en").delivery).toBe("PROMPT_PACKAGE");
  });
  it("preserves explicit stage count and allows a user to keep a dependent task in one prompt", () => {
    expect(
      analyzeSkillTask(
        "Split into two stages: first analyze; then write the report",
        "General",
        "en",
      ).stages,
    ).toHaveLength(2);
    expect(
      analyzeSkillTask(
        "第一阶段：分析资料。第二阶段：根据上一步分析结果写报告。",
        "General",
        "zh-CN",
      ).stages,
    ).toHaveLength(2);
    expect(
      analyzeSkillTask("分三个阶段分别交付需求、实现和验收提示词", "General", "en", "SINGLE_PROMPT")
        .delivery,
    ).toBe("SINGLE_PROMPT");
    expect(analyzeSkillTask("Write a story", "General", "en", "PROMPT_PACKAGE").delivery).toBe(
      "PROMPT_PACKAGE",
    );
  });
  it("qualitative advice checks the actual task without adding roles or selecting by category", () => {
    const p = deepSeekPrompts({
      ...input,
      kind: "EVALUATION_ADVICE",
      sourceContent: "Write one sentence",
    });
    expect(p.user).not.toContain("Business");
    expect(p.system).toContain("Already sufficient");
  });
  it("does not add a Skill solely because it shares an incidental term", () => {
    expect(
      matchSkillCandidates(
        "Write a birthday story for a child",
        [
          {
            versionId: "v",
            name: "write-database",
            description: "Write database backups and restore scripts",
          },
        ],
        "AUTO",
        [],
      ).picked,
    ).toEqual([]);
    expect(
      matchSkillCandidates(
        "Write a story for a child",
        [
          {
            versionId: "v",
            name: "story-storage",
            description: "Database storage for story records",
          },
        ],
        "AUTO",
        [],
      ).picked,
    ).toEqual([]);
  });
  it("selects mixed review aspects by source, independent of legacy classification", () => {
    const source = "分析销售数据，找出下滑原因，再写一段给老板看的汇报。";
    const a = modelEvaluationPrinciples("General", "zh-CN", source);
    const b = modelEvaluationPrinciples("Business", "zh-CN", source);
    expect(a.version).toBe("prompt-review-principles-v2");
    expect(a.layer2).toEqual(b.layer2);
    expect(a.selectionEvidence.map((e) => e.aspect)).toEqual(
      expect.arrayContaining(["analysis", "writing"]),
    );
    const report = parseModelEvaluation(
      JSON.stringify(syntheticEvaluation(source)),
      source,
      "General",
      "zh-CN",
    );
    expect(report.principlesSnapshot).toEqual(a);
    expect(modelEvaluationMarkdown(report, "Coding", "zh-CN")).toContain(a.layer2[0].name);
  });
  it("renders v1 historical dimensions under v1 rules", () => {
    const rules = legacyModelEvaluationPrinciples("Business", "en");
    const report = {
      principlesVersion: "prompt-review-principles-v1" as const,
      summary: "Historical",
      layer1: [],
      layer2: [
        {
          id: "L2_D1",
          judgment: "PRESENT" as const,
          reason: "historical",
          evidence: { kind: "EXCERPT" as const, quote: "evidence" },
        },
      ],
      layer2Status: "QUALITATIVE_ONLY" as const,
      layer3: { status: "NOT_EXECUTED" as const, executionId: null },
      suggestions: [],
      nextChecks: [],
    };
    expect(modelEvaluationMarkdown(report, "Business", "en")).toContain(rules.layer2[0].name);
    expect(
      modelEvaluationMarkdown({ ...report, principlesSnapshot: rules }, "Writing", "en"),
    ).toContain(rules.layer2[0].name);
  });
  it("does not select research checks from an explained word or negative instruction", () => {
    for (const source of [
      "Explain the word research in one sentence",
      "Do not research this; write a poem",
      "解释研究一词，用一句话回答",
    ])
      expect(
        modelEvaluationPrinciples("Research", "en", source).selectionEvidence.map((e) => e.aspect),
      ).not.toContain("research");
  });
  it("records exact task excerpts as the aspect selection evidence", () => {
    const source = 'Analyze "quoted irrelevant requirements" sales data and write a report.';
    expect(
      modelEvaluationPrinciples("General", "en", source).selectionEvidence.every((e) =>
        source.includes(e.quote),
      ),
    ).toBe(true);
  });
});
