import type { Locale, TaskType } from "./types";
export type MatchingMode = "AUTO" | "HYBRID" | "MANUAL";
export type SkillSelection = {
  versionId: string;
  name: string;
  responsibility: string;
  manifestSha256: string;
  resources: { path: string; sha256: string; type: string }[];
  notes: string[];
};
export type TaskAnalysis = ReturnType<typeof analyzeSkillTask>;
// Local, deterministic planning. These are engineering safety bounds, not subscription limits.
export const WORKFLOW_LIMITS = { skills: 4, contextBytes: 49152, candidates: 1000 } as const;
// Quoted text, code, blockquotes and explicitly introduced material are evidence, not tasks.
export function taskInstructionText(goal: string) {
  const mask = (value: string) => " ".repeat(value.length);
  return goal
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, mask)
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|'[^'\n]*'/g, mask)
    .replace(/^\s*>.*$/gm, mask)
    .replace(
      /(?:以下(?:材料|文本|原文|资料)|(?:following\s+)?(?:material|source text|text)\s*:)[\s\S]*/i,
      mask,
    );
}
export function analyzeSkillTask(
  goal: string,
  taskType: TaskType,
  locale: Locale,
  deliveryPreference: "AUTO" | "SINGLE_PROMPT" | "PROMPT_PACKAGE" = "AUTO",
) {
  const t = (en: string, zh: string) => (locale === "zh-CN" ? zh : en);
  const task = taskInstructionText(goal);
  const explicitSingle =
    /(?:不要|无需|不必|禁止).{0,12}(?:分.{0,6}阶段|阶段包)|(?:do not|don't|never).{0,12}(?:split|divide|stage)|(?:只|仅).{0,10}(?:一份|一个|单个)\s*(?:提示词|prompt)|(?:one|single)\s+(?:directly usable\s+)?prompt\s+only/i.test(
      task,
    );
  const explicitStages =
    /(?:分(?:为|成)?[一二两三四五六七八九十\d]+(?:个)?阶段|第[一二三四五六七八九十\d]+阶段|分阶段(?:交付|生成|输出|执行|完成)|阶段(?:包|提示词)|分别(?:交付|输出|生成).{0,20}(?:提示词|prompt)|(?:split|divide|deliver|generate|produce).{0,35}(?:stages|stage prompts|prompt package)|multi.stage\s+(?:delivery|prompts?))/i.test(
      task,
    );
  const explicitDependency =
    /(?:先[\s\S]{2,160}(?:然后|再|随后)[\s\S]{0,100}(?:根据|基于|使用|依赖)[\s\S]{0,40}(?:前一|上一步|前述|该|其|产物|结果)|(?:first|initially)[\s\S]{2,160}(?:then|next)[\s\S]{0,120}(?:using|based on|depend)[\s\S]{0,50}(?:previous|prior|schema|output|result))/i.test(
      task,
    );
  const complex =
    deliveryPreference === "PROMPT_PACKAGE" ||
    (deliveryPreference === "AUTO" && !explicitSingle && (explicitStages || explicitDependency));
  const numbers: Record<string, number> = {
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  const countToken = task.match(
    /(?:分(?:为|成)?([一二两三四五六七八九十\d]+)(?:个)?阶段)|(?:(two|three|four|five|\d+)\s+stages)/i,
  );
  const namedStages = [
    ...task.matchAll(/(?:第[一二三四五六七八九十\d]+阶段|stage\s+\d+)\s*[:：]\s*([^。；;\n]+)/gi),
  ].map((m) => m[1].trim());
  const rawCount = countToken?.[1] ?? countToken?.[2]?.toLowerCase();
  const stageCount = rawCount ? (numbers[rawCount] ?? Number(rawCount)) : namedStages.length || 2;
  const stages = complex
    ? namedStages.length > 1
      ? namedStages
      : Array.from({ length: Math.max(2, Math.min(20, stageCount || 2)) }, (_, i) =>
          t(
            `Stage ${i + 1}: preserve the requested deliverable and order`,
            `阶段 ${i + 1}：保留用户指定交付物与顺序`,
          ),
        )
    : [t("Deliver and verify", "交付与验证")];
  return {
    goal,
    taskType,
    locale,
    deliveryPreference,
    complexity: complex ? "MULTI_STAGE" : "SINGLE",
    complexityReason: complex
      ? t(
          "Explicit staged delivery, output dependency, or user-selected package",
          "明确分阶段交付、产物依赖或用户选择阶段包",
        )
      : t("No explicit staged dependency detected", "未识别出明确的阶段依赖"),
    delivery: complex ? "PROMPT_PACKAGE" : "SINGLE_PROMPT",
    stages: stages.map((name, i) => ({
      name,
      dependsOn: i ? [i - 1] : [],
      input: i
        ? t(
            "Attach the previous stage output when using a new conversation",
            "在新会话中使用时，附上前一阶段产物",
          )
        : t("User goal and supplied materials", "用户目标及已提供资料"),
      output: name,
      acceptance: t(
        "Verify against the user's explicit constraints; list unresolved items",
        "对照用户明确约束检查，列出未解决事项",
      ),
    })),
    unknowns: [
      t(
        "Identify only missing inputs that materially affect the task; use necessary placeholders, never invent background or unrelated budgets",
        "仅指出会实质影响任务的缺失输入，按需用占位符，不编造背景或无关预算",
      ),
    ],
    constraints: [
      t("User goal overrides conflicting Skill advice", "用户目标优先于冲突的 Skill 建议"),
      t(
        "No scripts/tools executed; the output is a prompt, not a completed task",
        "不执行脚本或工具，产物是提示词而非已完成的目标任务",
      ),
    ],
    successCriteria: t(
      "One usable prompt preserving user facts and constraints, with methods and checks only as needed",
      "保留用户事实与约束的可用提示词，仅按需补充方法与检查",
    ),
  };
}
export function matchSkillCandidates(
  goal: string,
  candidates: { versionId: string; name: string; description: string }[],
  mode: MatchingMode,
  selected: string[],
  locale: Locale = "en",
  manualOverride = false,
) {
  const instruction = taskInstructionText(goal).toLowerCase();
  const generic = new Set([
    "write",
    "create",
    "make",
    "help",
    "please",
    "for",
    "the",
    "and",
    "with",
    "using",
    "from",
    "task",
  ]);
  const terms = [...new Set(instruction.match(/[a-z0-9]{3,}|[\u3400-\u9fff]{2}/g) ?? [])].filter(
    (t) => !generic.has(t),
  );
  const responsibilities = [
    { id: "planning", pattern: /plan|requirements|规划|计划|需求/ },
    { id: "implementation", pattern: /implement|code|coding|typescript|开发|编程|实现/ },
    { id: "writing", pattern: /prose|story|editorial|copywriting|写作|故事|文案|汇报/ },
    { id: "analysis", pattern: /analy[sz]|dataset|统计|分析|数据/ },
    { id: "verification", pattern: /test|verif|debug|测试|验证|排错/ },
    { id: "interface", pattern: /accessib|interface|responsive|界面|无障碍|交互/ },
  ];
  const ranked = candidates
    .map((c) => {
      const text = `${c.name} ${c.description}`.toLowerCase();
      const matches = terms.filter((x) => text.includes(x));
      const relevantResponsibilities = responsibilities
        .filter((r) => r.pattern.test(instruction) && r.pattern.test(text))
        .map((r) => r.id);
      // A responsibility label triggered by the same one word is not independent evidence.
      const applicable = matches.length >= 2;
      return {
        ...c,
        score: applicable ? matches.length + relevantResponsibilities.length * 2 : 0,
        matches,
        responsibilities: applicable ? relevantResponsibilities : [],
        reason: applicable
          ? `Responsibility relevance: ${relevantResponsibilities.join(", ") || "specific task terms"}; supporting terms: ${matches.slice(0, 8).join(", ")}`
          : "No deterministic applicability evidence; not automatically selected",
      };
    })
    .sort((a, b) => b.score - a.score || a.versionId.localeCompare(b.versionId));
  const covered = new Set<string>(),
    automatic: string[] = [];
  for (const candidate of ranked) {
    if (automatic.length >= WORKFLOW_LIMITS.skills) break;
    const contributions = candidate.responsibilities.length
      ? candidate.responsibilities
      : [`specific-task:${[...candidate.matches].sort().join("+")}`];
    if (
      candidate.score > 0 &&
      contributions.some((responsibility) => !covered.has(responsibility))
    ) {
      automatic.push(candidate.versionId);
      contributions.forEach((responsibility) => covered.add(responsibility));
    }
  }
  const picked =
    mode === "MANUAL"
      ? selected
      : mode === "HYBRID" && (selected.length || manualOverride)
        ? selected
        : automatic;
  return {
    ranked: ranked.map((c) => ({
      ...c,
      selected: picked.includes(c.versionId),
      exclusionReason: picked.includes(c.versionId)
        ? null
        : c.score === 0
          ? "No applicability evidence"
          : "No additional relevant responsibility, excluded by user selection, or safety bound reached",
    })),
    picked: [...new Set(picked)],
    gaps: picked.length
      ? [
          locale === "zh-CN"
            ? "关键词匹配仅为有限适用性证据，请检查职责、缺失输入及环境依赖"
            : "Keyword applicability is limited evidence; review responsibilities and missing inputs before running",
        ]
      : [
          locale === "zh-CN"
            ? "未选中匹配的 Skill，仍可使用既有无 Skills 生成路径"
            : "No matching Skill selected. The existing no-Skills generation path remains available",
        ],
  };
}
