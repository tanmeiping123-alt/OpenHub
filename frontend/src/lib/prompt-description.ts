import type { Locale, TaskType } from "./types";

export type PurposeId = "create" | "understand" | "analyze" | "plan" | "build" | "improve";
export type PromptDescriptor = { purposes: PurposeId[]; tags: string[] };
export const purposes: { id: PurposeId; name: Record<Locale, string> }[] = [
  { id: "create", name: { en: "Create & express", "zh-CN": "创作与表达" } },
  { id: "understand", name: { en: "Understand & transform", "zh-CN": "理解与转换" } },
  { id: "analyze", name: { en: "Analyze & research", "zh-CN": "分析与研究" } },
  { id: "plan", name: { en: "Plan & decide", "zh-CN": "规划与决策" } },
  { id: "build", name: { en: "Develop & build", "zh-CN": "开发与构建" } },
  { id: "improve", name: { en: "Review & improve", "zh-CN": "检查与改进" } },
];
export const isPurposeId = (value: unknown): value is PurposeId =>
  purposes.some((purpose) => purpose.id === value);

export function legacyPurposes(taskType: TaskType): PurposeId[] {
  const mapping: Record<TaskType, PurposeId[]> = {
    Coding: ["build"],
    "UI/UX Design": ["build"],
    Writing: ["create"],
    "Data Analysis": ["analyze"],
    Business: ["plan"],
    Research: ["analyze"],
    "AI Agent": ["build"],
    General: [],
  };
  return [...(mapping[taskType] ?? [])];
}

type DescribedPrompt = { taskType: TaskType; descriptor?: PromptDescriptor };
export function descriptorForPrompt(prompt: DescribedPrompt): PromptDescriptor {
  return prompt.descriptor ?? { purposes: legacyPurposes(prompt.taskType), tags: [] };
}
export function promptPurposeLabel(prompt: DescribedPrompt, locale: Locale): string {
  const selected = descriptorForPrompt(prompt).purposes;
  return selected.length
    ? selected
        .map((id) => purposes.find((p) => p.id === id)!.name[locale])
        .join(locale === "zh-CN" ? "、" : ", ")
    : locale === "zh-CN"
      ? "未分类"
      : "Uncategorized";
}
export function promptDiscoveryTerms(prompt: DescribedPrompt): string[] {
  const descriptor = descriptorForPrompt(prompt);
  return [
    ...descriptor.tags,
    ...descriptor.purposes.flatMap((id) => Object.values(purposes.find((p) => p.id === id)!.name)),
  ];
}

// One maintained vocabulary drives both tag consolidation and discovery matching.
export const searchSynonyms: readonly (readonly [string, string])[] = [
  ["résumé", "resume"],
  ["简历修改", "简历优化"],
  ["简历润色", "简历优化"],
  ["写文案", "文案写作"],
  ["文案创作", "文案写作"],
  ["resume editing", "resume optimization"],
  ["resume improvement", "resume optimization"],
  ["copy writing", "copywriting"],
];
export function canonicalSearch(value: string): string {
  let result = value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  for (const [alias, canonical] of searchSynonyms) result = result.replaceAll(alias, canonical);
  return result.replace(/\s+/g, " ").trim();
}
export function normalizeTags(tags: string[]): string[] {
  if (!Array.isArray(tags) || tags.length > 12) throw new Error("INVALID_DESCRIPTOR");
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    if (
      typeof raw !== "string" ||
      raw.length > 40 ||
      /[\u0000-\u001f\u007f<>]|https?:\/\/|www\./i.test(raw)
    )
      throw new Error("INVALID_DESCRIPTOR");
    const tag = raw.normalize("NFKC").trim().replace(/\s+/g, " ");
    if (!tag || tag.length > 40) throw new Error("INVALID_DESCRIPTOR");
    const key = canonicalSearch(tag);
    if (seen.has(key)) continue;
    seen.add(key);
    const canonical = searchSynonyms.some(([alias]) => alias === tag.toLowerCase()) ? key : tag;
    result.push(canonical.toLowerCase() === "ai agent" ? "AI Agent" : canonical);
  }
  return result;
}
export function parsePromptDescriptor(value: unknown): PromptDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_DESCRIPTOR");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some((key) => !["purposes", "tags"].includes(key)) ||
    !Array.isArray(v.purposes) ||
    v.purposes.length > 6 ||
    !v.purposes.every(isPurposeId) ||
    !Array.isArray(v.tags)
  )
    throw new Error("INVALID_DESCRIPTOR");
  return { purposes: [...new Set(v.purposes)], tags: normalizeTags(v.tags) };
}
export function suggestPromptDescriptor(goal: string, locale: Locale): PromptDescriptor {
  const rules: [PurposeId, RegExp][] = [
    ["create", /写|创作|文案|故事|汇报|海报|\b(write|writing|create|story|copywriting)\b/i],
    [
      "understand",
      /解释|总结|概括|翻译|转换|改写|\b(explain|summari[sz]e|translate|convert|rewrite)\b/i,
    ],
    ["analyze", /分析|研究|原因|比较|\b(analy[sz]e|analysis|research|compare)\b/i],
    ["plan", /规划|计划|方案|决策|选型|\b(plan|planning|decide|decision)\b/i],
    ["build", /编程|开发|构建|界面|自动化|\b(code|coding|develop|build|automation|agent)\b/i],
    [
      "improve",
      /优化|改进|修改|排错|审查|校对|评估|\b(improve|review|debug|proofread|evaluate)\b/i,
    ],
  ];
  const tags: string[] = [];
  for (const [pattern, zh, en] of [
    [/销售|\bsales\b/i, "销售", "Sales"],
    [/数据|\bdata\b/i, "数据分析", "Data analysis"],
    [/汇报|\breport\b/i, "汇报", "Report"],
    [/简历|\bresume\b/i, "简历优化", "Resume optimization"],
    [/agent/i, "AI Agent", "AI Agent"],
    [/翻译|\btranslate\b/i, "翻译", "Translation"],
  ] as const)
    if (pattern.test(goal)) tags.push(locale === "zh-CN" ? zh : en);
  return {
    purposes: rules.filter(([, pattern]) => pattern.test(goal)).map(([purpose]) => purpose),
    tags,
  };
}
