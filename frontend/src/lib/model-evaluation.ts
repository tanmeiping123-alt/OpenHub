import { candidateLayer2, layer1Rubric } from "./calibration-rubric";
import type { Locale, TaskType } from "./types";
import { taskInstructionText } from "./skill-workflow";

export const MODEL_EVALUATION_VERSION = "prompt-review-principles-v2";
export const LEGACY_MODEL_EVALUATION_VERSION = "prompt-review-principles-v1";
export type ReviewEvidence = {
  kind: "EXCERPT" | "OBSERVED_ABSENCE" | "UNAVAILABLE";
  quote: string;
};
export type ReviewFinding = {
  id: string;
  judgment: "PRESENT" | "NEEDS_IMPROVEMENT" | "INSUFFICIENT_INFORMATION" | "NOT_APPLICABLE";
  reason: string;
  evidence: ReviewEvidence;
};
export type ModelEvaluation = {
  principlesVersion: typeof MODEL_EVALUATION_VERSION | typeof LEGACY_MODEL_EVALUATION_VERSION;
  principlesSnapshot?:
    | ReturnType<typeof modelEvaluationPrinciples>
    | (ReturnType<typeof legacyModelEvaluationPrinciples> & { selectionEvidence?: never });
  summary: string;
  layer1: ReviewFinding[];
  layer2: ReviewFinding[];
  layer2Status: "QUALITATIVE_ONLY" | "NOT_AVAILABLE";
  layer3: { status: "NOT_EXECUTED" | "EXECUTED_UNGRADED"; executionId: string | null };
  suggestions: {
    dimensionId: string;
    priority: "HIGH" | "MEDIUM" | "LOW";
    issue: string;
    evidence: ReviewEvidence;
    replacement: string;
    rationale: string;
  }[];
  nextChecks: string[];
};

export function legacyModelEvaluationPrinciples(taskType: TaskType, locale: Locale) {
  const special: Partial<Record<TaskType, { name: string; guide: string }[]>> = {
    Coding: [
      {
        name: "Implementation and checks / 实现与校验",
        guide:
          "Environment, interfaces, error/security boundaries and test acceptance; do not claim code ran. 环境、接口、错误/安全边界及测试验收；不声称代码已执行。",
      },
    ],
    "UI/UX Design": [
      {
        name: "Interaction and accessibility / 交互与无障碍",
        guide:
          "User flow, states, responsiveness and accessibility; do not infer rendered usability. 用户流程、状态、响应式与无障碍；不推断实际可用性。",
      },
    ],
    Writing: [
      {
        name: "Audience and editorial requirements / 受众与写作要求",
        guide:
          "Audience, purpose, voice, structure and factual/citation requirements; do not invent facts. 受众、目的、语气、结构及事实/引用要求；不编造事实。",
      },
    ],
  };
  return {
    version: LEGACY_MODEL_EVALUATION_VERSION,
    taskType,
    scope:
      "Prompt text only; no external materials or execution outputs reviewed. Qualitative judgments, no scores, grades or cross-layer aggregation. Candidate task checks are not approved scoring rubrics.",
    layer1: layer1Rubric.map((d) => ({
      id: d.id,
      name: d.name[locale],
      checks: d.indicators.map((i) => i.checkpoint[locale]),
    })),
    layer2:
      taskType === "General"
        ? []
        : (
            candidateLayer2[taskType]?.map((d) => ({
              name: d.name[locale],
              guide: d.checkpoints[locale],
            })) ??
            special[taskType] ??
            []
          ).map((d, i) => ({ id: `L2_D${i + 1}`, ...d })),
  };
}

// Legacy classification is retained as history only. New checks use explicit task text,
// with multiple aspects allowed and conservative empty selection for ambiguous tasks.
export function modelEvaluationPrinciples(_taskType: TaskType, locale: Locale, source = "") {
  // This masked copy is only for selecting applicable checks. The full source,
  // including every prohibition, remains in the judging request and evidence validator.
  const instruction = taskInstructionText(source).replace(
    /\b(?:do\s+not|don't|never|must\s+not|should\s+not|avoid|no\s+need\s+to)\b(?:(?!\b(?:but|instead|rather)\b)[^,，;；.!?。！？\n])*|(?:不要|不得|禁止|无需|不必|不能)[^,，;；.!?。！？\n]*/gi,
    (clause) => " ".repeat(clause.length),
  );
  const clauses = [...instruction.matchAll(/[^,，;；.!?。！？\n]+/g)];
  const aspects = [
    {
      aspect: "analysis",
      task: "Data Analysis" as const,
      pattern:
        /(?:分析|统计|analy[sz]e|analy[sz]ing|analy[sz]is).{0,30}(?:数据|销售|dataset|data|sales)|(?:data|sales).{0,25}analy[sz]is/i,
    },
    {
      aspect: "writing",
      task: "Writing" as const,
      pattern:
        /(?:写|撰写|起草|write|draft|compose).{0,35}(?:文案|文章|故事|汇报|报告|邮件|诗|story|copy|article|report|email|paragraph|poem)|(?:copywriting|creative writing)/i,
    },
    {
      aspect: "coding",
      task: "Coding" as const,
      pattern:
        /(?:实现|编写|开发|修复|implement|build|debug|write).{0,35}(?:代码|程序|接口|脚本|客户端|code|script|function|api|client|application)|(?:typescript|javascript|python).{0,20}(?:code|function|代码|函数)/i,
    },
    {
      aspect: "interface",
      task: "UI/UX Design" as const,
      pattern:
        /(?:设计|构建|design|build).{0,25}(?:界面|交互|页面|无障碍|interface|ui\b|user flow|accessible)/i,
    },
    {
      aspect: "research",
      task: "Research" as const,
      pattern:
        /(?:^\s*|[.!?;\n]\s*|(?:and|then)\s+)(?:(?:please|请|帮我)\s*)?(?:research\b|investigate\b|conduct\s+(?:a\s+)?(?:study|research)|研究|调研)|(?:撰写|整理|provide|write|compile).{0,20}(?:文献综述|literature review)|compare sources/i,
    },
    {
      aspect: "decision",
      task: "Business" as const,
      pattern: /(?:决策|选型|比较.{0,20}方案|decision|trade.offs|choose between|compare options)/i,
    },
    {
      aspect: "agent",
      task: "AI Agent" as const,
      pattern: /(?:设计|开发|构建|design|build|implement).{0,30}(?:agent|智能体)/i,
    },
  ];
  const selected = aspects.flatMap((a) => {
    for (const clause of clauses) {
      const match = clause[0].match(a.pattern);
      if (match) {
        const start = clause.index! + match.index!;
        return [{ ...a, quote: source.slice(start, start + match[0].length) }];
      }
    }
    return [];
  });
  const base = legacyModelEvaluationPrinciples("General", locale);
  return {
    version: MODEL_EVALUATION_VERSION,
    scope:
      base.scope +
      " Apply only checks relevant to explicit requirements. Already sufficient prompts may need no edits. Missing roles/headings/steps are not defects by themselves. Check repetition, conflicting constraints, irrelevant process and over-specified methods without rewarding brevity or penalizing length alone.",
    selectionEvidence: selected.map((a) => ({
      aspect: a.aspect,
      quote: a.quote,
      basis:
        "Explicit requirements in supplied prompt text; labels and taskType are not selection inputs",
    })),
    layer1: base.layer1,
    layer2: selected.flatMap((a) =>
      legacyModelEvaluationPrinciples(a.task, locale).layer2.map((d, i) => ({
        ...d,
        id: `L2_${a.aspect.toUpperCase()}_D${i + 1}`,
      })),
    ),
  };
}

export function modelEvaluationRulesForReport(
  report: ModelEvaluation,
  taskType: TaskType,
  locale: Locale,
) {
  return (
    report.principlesSnapshot ??
    (report.principlesVersion === LEGACY_MODEL_EVALUATION_VERSION
      ? legacyModelEvaluationPrinciples(taskType, locale)
      : modelEvaluationPrinciples(taskType, locale))
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, max = 1800): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= max;
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}
function evidence(value: unknown, source: string): value is ReviewEvidence {
  return (
    record(value) &&
    exactKeys(value, ["kind", "quote"]) &&
    typeof value.quote === "string" &&
    (value.kind === "EXCERPT"
      ? text(value.quote, 400) && source.includes(value.quote)
      : ["OBSERVED_ABSENCE", "UNAVAILABLE"].includes(String(value.kind)) && value.quote === "")
  );
}

// Supplier content is data: reject fabricated quotes, hidden fields, scores and malformed JSON.
export function parseModelEvaluation(
  content: string,
  source: string,
  taskType: TaskType,
  locale: Locale,
): ModelEvaluation {
  const invalid = () => {
    throw new Error("INVALID_MODEL_EVALUATION_REPORT");
  };
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return invalid();
  }
  if (
    !record(data) ||
    !exactKeys(data, ["summary", "layer1", "layer2", "suggestions", "nextChecks"]) ||
    !text(data.summary)
  )
    return invalid();
  const rules = modelEvaluationPrinciples(taskType, locale, source);
  const findings = (value: unknown, ids: string[]): value is ReviewFinding[] =>
    Array.isArray(value) &&
    value.length === ids.length &&
    new Set(value.map((f) => f?.id)).size === ids.length &&
    value.every(
      (f) =>
        record(f) &&
        exactKeys(f, ["id", "judgment", "reason", "evidence"]) &&
        ids.includes(String(f.id)) &&
        text(f.reason) &&
        ["PRESENT", "NEEDS_IMPROVEMENT", "INSUFFICIENT_INFORMATION", "NOT_APPLICABLE"].includes(
          String(f.judgment),
        ) &&
        evidence(f.evidence, source) &&
        (f.judgment === "PRESENT"
          ? f.evidence.kind === "EXCERPT"
          : f.judgment === "INSUFFICIENT_INFORMATION"
            ? f.evidence.kind === "UNAVAILABLE"
            : true) &&
        (f.evidence.kind !== "OBSERVED_ABSENCE" || f.judgment === "NEEDS_IMPROVEMENT"),
    );
  if (
    !findings(
      data.layer1,
      rules.layer1.map((d) => d.id),
    ) ||
    !findings(
      data.layer2,
      rules.layer2.map((d) => d.id),
    )
  )
    return invalid();
  const ids = [...rules.layer1, ...rules.layer2].map((d) => d.id);
  if (
    !Array.isArray(data.suggestions) ||
    data.suggestions.length > 3 ||
    !data.suggestions.every(
      (s) =>
        record(s) &&
        exactKeys(s, [
          "dimensionId",
          "priority",
          "issue",
          "evidence",
          "replacement",
          "rationale",
        ]) &&
        ids.includes(String(s.dimensionId)) &&
        ["HIGH", "MEDIUM", "LOW"].includes(String(s.priority)) &&
        text(s.issue) &&
        evidence(s.evidence, source) &&
        text(s.replacement, 3000) &&
        text(s.rationale),
    )
  )
    return invalid();
  if (
    !Array.isArray(data.nextChecks) ||
    data.nextChecks.length < 1 ||
    data.nextChecks.length > 5 ||
    !data.nextChecks.every((v) => text(v, 500))
  )
    return invalid();
  return {
    principlesVersion: MODEL_EVALUATION_VERSION,
    principlesSnapshot: rules,
    summary: data.summary,
    layer1: rules.layer1.map((d) => (data.layer1 as ReviewFinding[]).find((f) => f.id === d.id)!),
    layer2: rules.layer2.map((d) => (data.layer2 as ReviewFinding[]).find((f) => f.id === d.id)!),
    layer2Status: rules.layer2.length ? "QUALITATIVE_ONLY" : "NOT_AVAILABLE",
    layer3: { status: "NOT_EXECUTED", executionId: null },
    suggestions: data.suggestions as ModelEvaluation["suggestions"],
    nextChecks: data.nextChecks as string[],
  };
}

export function modelEvaluationMarkdown(
  report: ModelEvaluation,
  taskType: TaskType,
  locale: Locale,
) {
  const zh = locale === "zh-CN";
  const rules = modelEvaluationRulesForReport(report, taskType, locale);
  const judgments = zh
    ? {
        PRESENT: "原文有支持",
        NEEDS_IMPROVEMENT: "建议改进",
        INSUFFICIENT_INFORMATION: "信息不足",
        NOT_APPLICABLE: "不适用",
      }
    : {
        PRESENT: "Supported by text",
        NEEDS_IMPROVEMENT: "Needs improvement",
        INSUFFICIENT_INFORMATION: "Insufficient information",
        NOT_APPLICABLE: "Not applicable",
      };
  const showEvidence = (e: ReviewEvidence) =>
    e.kind === "EXCERPT"
      ? `> ${e.quote.replace(/\n/g, "\n> ")}`
      : zh
        ? e.kind === "OBSERVED_ABSENCE"
          ? "依据：模型认为已读全文存在必要要求遗漏（需人工复核）。"
          : "依据：所需材料未读取或信息不足。"
        : e.kind === "OBSERVED_ABSENCE"
          ? "Evidence: model-reported absence in reviewed text; verify manually."
          : "Evidence: unavailable or insufficient material.";
  const layer = (rows: ReviewFinding[]) =>
    rows
      .map(
        (f) =>
          `### ${[...rules.layer1, ...rules.layer2].find((d) => d.id === f.id)?.name ?? f.id} · ${judgments[f.judgment]}\n\n${f.reason}\n\n${showEvidence(f.evidence)}`,
      )
      .join("\n\n");
  return [
    zh ? "# 真实模型评估报告" : "# Live model evaluation report",
    zh
      ? "模型辅助定性评估，不是正式分数或执行验收；仅审查当前已保存 Prompt 文本，模型判断需人工复核。"
      : "Model-assisted qualitative review, not a formal score or execution acceptance. Only saved prompt text was reviewed; verify model judgments.",
    report.summary,
    zh ? "## Layer 1 · 通用质量" : "## Layer 1 · General quality",
    layer(report.layer1),
    zh ? "## Layer 2 · 任务专项" : "## Layer 2 · Task-specific review",
    report.layer2Status === "NOT_AVAILABLE"
      ? zh
        ? report.principlesVersion === LEGACY_MODEL_EVALUATION_VERSION
          ? "General 不提供专项量表；无分数。"
          : "未识别出需要专项检查的明确任务要求；无分数。"
        : report.principlesVersion === LEGACY_MODEL_EVALUATION_VERSION
          ? "General has no task-specific rubric; no score."
          : "No explicit task requirements selected for specialized checks; no score."
      : layer(report.layer2),
    zh ? "## Layer 3 · 执行边界" : "## Layer 3 · Execution boundary",
    report.layer3.status === "NOT_EXECUTED"
      ? zh
        ? "未执行；无分数、无等级。"
        : "Not executed; no score or grade."
      : zh
        ? "已有真实执行记录，但本报告未审查执行输出；未评分。"
        : "Real execution record exists, but its output was not reviewed here; ungraded.",
    zh ? "## 优先优化建议" : "## Prioritized optimization suggestions",
    ...report.suggestions.map(
      (s, i) =>
        `### ${i + 1}. ${s.priority} · ${s.issue}\n\n${showEvidence(s.evidence)}\n\n${zh ? "建议修改" : "Proposed edit"}：${s.replacement}\n\n${zh ? "理由" : "Rationale"}：${s.rationale}`,
    ),
    zh ? "## 下一步核对" : "## Next checks",
    ...report.nextChecks.map((s) => `- ${s}`),
  ].join("\n\n");
}
