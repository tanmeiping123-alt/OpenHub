import type { LiveAdvice, Locale } from "./types";
import { catalogModel, type ModelSelection } from "./model-catalog";

// Text markers only: finding a word is not evidence of semantic quality.
const checks = [
  {
    id: "role",
    en: "Role",
    zh: "角色",
    pattern: /\b(?:act as|you are|role|specialist|assistant)\b|作为|扮演|你是|角色/i,
  },
  {
    id: "goal",
    en: "Goal",
    zh: "目标",
    pattern: /\b(?:goal|objective|task|create|produce|implement)\b|目标|任务|请|生成|实现/i,
  },
  {
    id: "context",
    en: "Context / assumptions",
    zh: "上下文／假设",
    pattern: /\b(?:context|background|input|assumptions?|audience)\b|上下文|背景|输入|假设|受众/i,
  },
  {
    id: "constraints",
    en: "Constraints / boundaries",
    zh: "约束／边界",
    pattern:
      /\b(?:must|never|avoid|constraints?|requirements?|do not)\b|必须|禁止|不得|不要|约束|边界|要求/i,
  },
  {
    id: "format",
    en: "Output format",
    zh: "输出格式",
    pattern: /\b(?:format|json|markdown|table|sections?|bullets?)\b|格式|表格|分节|列表|小标题/i,
  },
  {
    id: "verification",
    en: "Verification / uncertainty",
    zh: "验证／不确定性",
    pattern:
      /\b(?:verify|verification|acceptance|tests?|evidence|uncertain|checks?|citations?)\b|验证|验收|测试|证据|不确定|核对|引用/i,
  },
] as const;

export function diagnosePrompt(content: string, locale: Locale) {
  return checks.map((check) => {
    const match = check.pattern.exec(content);
    const start = match ? Math.max(0, match.index - 24) : null;
    const end = match ? Math.min(content.length, match.index + match[0].length + 48) : null;
    return {
      id: check.id,
      label: locale === "zh-CN" ? check.zh : check.en,
      status: match ? ("MARKER_FOUND" as const) : ("NOT_DETECTED" as const),
      // Preserve the exact source text and UTF-16 offsets, without normalization.
      evidence:
        start !== null && end !== null ? { start, end, quote: content.slice(start, end) } : null,
    };
  });
}

export function adviceMatchesSelection(advice: LiveAdvice, selection: ModelSelection) {
  const model = catalogModel(selection.modelKey);
  if (!model || advice.provider !== model.provider) return false;
  if (
    advice.model !== model.model &&
    advice.productVersion !== model.name &&
    advice.productVersion !== model.model
  )
    return false;
  // Old records with unknown strength are not evidence for a selected tier.
  return advice.strength === (selection.strength ?? model.defaultStrength);
}

export function adviceHistoryForVersion(advice: LiveAdvice[], promptId: string, versionId: string) {
  return advice
    .filter(
      (item) =>
        item.kind !== "EVALUATION_REPORT" &&
        item.promptId === promptId &&
        item.versionId === versionId,
    )
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
}
