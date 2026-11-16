import type {
  AppState,
  EvaluationReport,
  LayerState,
  Prompt,
  PromptVersion,
  Suggestion,
  TaskType,
} from "./types";

export const taskTypes: TaskType[] = [
  "Coding",
  "UI/UX Design",
  "Writing",
  "Data Analysis",
  "Business",
  "Research",
  "AI Agent",
  "General",
];
const localizedContent: Record<string, string> = {
  ver_coding_csv_01:
    "编写一个 Python 函数，读取 UTF-8 CSV 文件，验证必需列，报告格式错误的行，并返回类型明确的记录列表。请为文件为空和字段中包含引号逗号的情况编写测试。",
  ver_ui_checkout_01:
    "请从清晰度和无障碍角度评审移动端结账流程。指出主要用户风险，提出信息层级，并为错误恢复提供验收标准。",
  ver_writing_course_01:
    "为初学者制定一个三天的 Prompt Engineering 学习计划。每天安排一节 30 分钟课程、一个简短练习和一道自检问题。使用平实、鼓励性的语言。",
  ver_writing_course_02:
    "为初学者制定一个三天的 Prompt Engineering 学习计划。每天包含一节 20 分钟课程、引导式练习和反思问题。使用平实语言和真实示例，并以简短进度清单结尾。",
  ver_writing_course_03:
    "为初学者制定实用的三天 Prompt Engineering 计划。每天包含一节 20 分钟课程、一个讲解示例、一个引导练习和一道反思问题。使用平实语言，并以进度清单结尾。",
  ver_data_sales_01: "按地区和产品分析月度销售额。检查缺失值，描述趋势，并建议合适的图表。",
  ver_data_sales_02:
    "给定包含日期、地区、产品、销量和收入字段的月度销售数据，先检查缺失值与重复项，再开始分析。按地区和产品总结月环比变化；说明假设、展示计算过程，并仅在有助于比较趋势时推荐图表。不要推断缺失观测值。",
  ver_business_launch_01:
    "为一个小型在线语言课程起草发布计划。列出受众假设、关键里程碑，以及发布后需要检查的指标。",
  ver_research_claim_01:
    "评估“检索练习可以提升长期学习效果”这一主张。区分支持性证据与未知项，并提出用于查找原始研究的搜索词。",
  ver_agent_triage_01:
    "按紧急程度和主题分类每条支持工单。缺少信息时先提问；不要承诺退款；遇到安全问题或账单争议时转交人工处理。",
  ver_general_notes_01:
    "将以下会议记录整理为简明摘要，包含决策、负责人和未决问题。将不确定事项明确标为待确认。",
};
export function localizedContentFor(versionId: string, locale: "en" | "zh-CN", fallback: string) {
  return locale === "zh-CN" ? (localizedContent[versionId] ?? fallback) : fallback;
}
export function localizedTaskType(type: TaskType, locale: "en" | "zh-CN") {
  if (locale === "en") return type;
  return (
    {
      Coding: "编程",
      "UI/UX Design": "UI/UX 设计",
      Writing: "写作",
      "Data Analysis": "数据分析",
      Business: "商业",
      Research: "研究",
      "AI Agent": "AI Agent",
      General: "通用",
    } as const
  )[type];
}
export function localizedMode(mode: "simple" | "professional", locale: "en" | "zh-CN") {
  if (locale === "en") return mode === "simple" ? "Simple" : "Professional";
  return mode === "simple" ? "简易模式" : "专家模式";
}
export function localizedPromptKind(kind: Prompt["kind"], locale: "en" | "zh-CN") {
  if (locale === "en") return kind === "TEMPLATE" ? "Template" : "Personal Prompt";
  return kind === "TEMPLATE" ? "模板" : "个人 Prompt";
}
export function localizedSource(source: string, locale: "en" | "zh-CN") {
  if (locale === "en") return source;
  const translations: Record<string, string> = {
    Generated: "已生成",
    Template: "模板",
    Edited: "已编辑",
    Optimized: "已优化",
    "Edited · simulated": "已编辑 · 模拟演示",
    "Generated · simulated": "已生成 · 模拟演示",
    Restored: "已恢复",
    "MOCK / SIMULATED": "模拟演示",
  };
  const restored = source.match(/^Restored from v(\d+) · simulated$/);
  if (restored) return `从 v${restored[1]} 恢复 · 模拟演示`;
  return translations[source] ?? source;
}
export function localizedDimensionName(name: string, locale: "en" | "zh-CN") {
  if (locale === "en") return name;
  const translations: Record<string, string> = {
    "Goal Clarity": "目标清晰度",
    "Context Completeness": "上下文完整性",
    "Instruction Structure": "指令结构",
    "Constraints & Boundaries": "约束与边界",
    "Output Specification": "输出规范",
    "Precision & Verifiability": "精确性与可验证性",
    "Audience Fit": "受众匹配度",
    "Input contract": "输入约定",
  };
  return translations[name] ?? name;
}
export function localizedReason(reason: string, locale: "en" | "zh-CN") {
  if (locale === "en") return reason;
  const translations: Record<string, string> = {
    "The prompt states a clear user goal.": "Prompt 明确说明了用户目标。",
    "Illustrative evidence from this exact prompt version.":
      "此示例依据当前 Prompt 版本中的具体内容。",
    "A beginner audience is explicitly named. No task score is calculated.":
      "已明确指定初学者受众；不计算任务专项分数。",
    "Required columns and malformed-row behavior are named; correctness is not executed.":
      "已说明必需列和异常行的处理方式；尚未实际执行正确性验证。",
    "No approved runtime scoring formula is active for this ad hoc draft.":
      "此临时草稿没有适用的已批准运行时评分公式。",
  };
  return translations[reason] ?? reason;
}
export function localizedNotice(message: string | null, locale: "en" | "zh-CN") {
  if (!message || locale === "en") return message;
  const exact: Record<string, string> = {
    "Session storage is unavailable; changes remain in memory only.":
      "会话存储不可用；更改仅保存在内存中。",
    "Evaluation failed; the Prompt version reference is invalid.":
      "评估失败：Prompt 版本引用无效。",
    "Calibration failed; save the source version and check its evidence.":
      "校准失败：请保存来源版本并检查证据。",
    "Local calibration saved; no AI was called. Grade remains pending.":
      "本地校准已保存；未调用 AI，等级仍待确认。",
    "Favorite updated in this demo session.": "已在本次演示会话中更新收藏。",
    "Saved to Library · Mock / Simulated": "已保存到 Prompt 库 · 模拟演示",
    "Removed from Library · Prompt history is preserved": "已从 Prompt 库移除 · 历史记录仍会保留",
    "Evaluation preview ready · Mock / Simulated": "评估预览已就绪 · 模拟演示",
    "Comparison prepared · Mock / Simulated; no model was called.":
      "对比结果已准备就绪 · 模拟演示，未调用任何模型。",
    "Profile updated in this demo session.": "已在本次演示会话中更新资料。",
    "Stored demo data could not be restored; starter examples are ready.":
      "无法恢复已存储的演示数据，已载入初始示例。",
    "Demo prompt not found.": "未找到演示 Prompt。",
    "Generate a Prompt before saving a version.": "请先生成 Prompt，再保存新版本。",
    "Demo save failed; existing content is preserved.": "演示保存失败，现有内容已保留。",
    "New Prompt version saved · Mock / Simulated": "新的 Prompt 版本已保存 · 模拟演示",
    "Restore failed; history is unchanged.": "恢复失败，历史记录未更改。",
    "Optimization preview ready; original version is unchanged.":
      "优化预览已就绪，原版本保持不变。",
    "Personal copy created; template is unchanged.": "个人副本已创建，模板保持不变。",
    "Demo sign-in complete · no account service was contacted.": "演示登录完成 · 未连接账户服务。",
    "Database sync unavailable; local demo data remains active.":
      "数据库同步不可用；当前仍使用本地演示数据。",
    "Database API is unavailable; this change is only in the current demo session.":
      "数据库 API 不可用；本次更改仅存在于当前演示会话。",
    "Database sync failed; no local success was shown.": "数据库同步失败；未显示本地成功状态。",
    "Prompt version changed; reload and retry.": "Prompt 版本已变化；请重新加载后重试。",
    "Change was sent to the database, but refresh failed; reload to reconcile the view.":
      "更改已发送至数据库，但刷新失败；请重新加载以同步视图。",
    "Calibration remains in this browser session; database sync is not supported.":
      "校准结果仅保留在当前浏览器会话中；不支持数据库同步。",
  };
  if (exact[message]) return exact[message];
  const mode = message.match(/^Mode changed to (Simple|Professional) · demo$/);
  if (mode) return `已切换至${mode[1] === "Simple" ? "简易模式" : "专家模式"} · 演示`;
  const tier = message.match(/^(Free|Pro) demo scenario selected; permissions remain TBD\.$/);
  if (tier) return `已选择 ${tier[1]} 演示场景；权限仍待确认。`;
  const restored = message.match(/^Restored as a new version from v(\d+) · Mock \/ Simulated$/);
  if (restored) return `已从 v${restored[1]} 恢复为新版本 · 模拟演示`;
  const generated = message.match(/^Prompt generated · Mock \/ Simulated$/);
  if (generated) return "Prompt 已生成 · 模拟演示";
  return message;
}
const localizedTitles: Record<string, string> = {
  prm_coding_csv_01: "安全解析 CSV",
  prm_ui_checkout_01: "结账流程评审",
  prm_writing_course_01: "三天学习计划",
  prm_data_sales_01: "月度销售分析",
  prm_business_launch_01: "产品发布计划",
  prm_research_claim_01: "研究主张核查",
  prm_agent_triage_01: "支持工单分流",
  prm_general_notes_01: "整理会议记录",
};
export function localizedTitleFor(promptId: string, locale: "en" | "zh-CN", fallback: string) {
  return locale === "zh-CN" ? (localizedTitles[promptId] ?? fallback) : fallback;
}
const l1Names = [
  "Goal Clarity",
  "Context Completeness",
  "Instruction Structure",
  "Constraints & Boundaries",
  "Output Specification",
  "Precision & Verifiability",
];
const l1Weights = [20, 20, 15, 15, 15, 15];
const l1Mock = (scores: number[]): LayerState => ({
  status: "MOCK / SIMULATED",
  score: null,
  grade: null,
  dimensions: l1Names.map((name, i) => ({
    name,
    weight: l1Weights[i],
    score: scores[i],
    state: "ASSESSED · MOCK",
    reason:
      i === 0
        ? "The prompt states a clear user goal."
        : "Illustrative evidence from this exact prompt version.",
  })),
});
const unavailable: LayerState = {
  status: "NOT_AVAILABLE",
  score: null,
  grade: null,
  dimensions: [],
};
const notExecuted: LayerState = {
  status: "NOT_EXECUTED",
  score: null,
  grade: null,
  dimensions: [],
};

export const versions: PromptVersion[] = [
  {
    id: "ver_coding_csv_01",
    promptId: "prm_coding_csv_01",
    number: 1,
    title: "Parse a CSV safely",
    content:
      "Write a Python function that reads a UTF-8 CSV file, validates required columns, reports malformed rows, and returns a typed list of records. Include tests for empty files and quoted commas.",
    createdBy: "fixture",
    source: "Generated",
    createdAt: "2026-10-28",
  },
  {
    id: "ver_ui_checkout_01",
    promptId: "prm_ui_checkout_01",
    number: 1,
    title: "Checkout flow review",
    content:
      "Review a mobile checkout flow for clarity and accessibility. Identify the key user risks, propose a hierarchy, and give acceptance criteria for error recovery.",
    createdBy: "fixture",
    source: "Template",
    createdAt: "2026-10-27",
  },
  {
    id: "ver_writing_course_01",
    promptId: "prm_writing_course_01",
    number: 1,
    title: "Three-day learning plan",
    content:
      "Create a three-day beginner plan for learning prompt engineering. For each day, give one 30-minute lesson, a short practice exercise, and a self-check question. Use plain language and a supportive tone.",
    createdBy: "fixture",
    source: "Generated",
    createdAt: "2026-10-20",
  },
  {
    id: "ver_writing_course_02",
    promptId: "prm_writing_course_01",
    number: 2,
    title: "Three-day learning plan",
    content:
      "Create a three-day beginner plan for learning prompt engineering. Each day includes a 20-minute lesson, a guided practice, and a reflection question. Use plain language, realistic examples, and a supportive tone. End with a short progress checklist.",
    createdBy: "fixture",
    source: "Edited",
    createdAt: "2026-10-24",
    parentVersionId: "ver_writing_course_01",
  },
  {
    id: "ver_writing_course_03",
    promptId: "prm_writing_course_01",
    number: 3,
    title: "Three-day learning plan",
    content:
      "Create a practical three-day prompt engineering plan for beginners. Each day includes a 20-minute lesson, a worked example, a guided exercise, and one reflection question. Use plain language and end with a progress checklist.",
    createdBy: "fixture",
    source: "Optimized",
    createdAt: "2026-10-29",
    parentVersionId: "ver_writing_course_02",
  },
  {
    id: "ver_data_sales_01",
    promptId: "prm_data_sales_01",
    number: 1,
    title: "Explore monthly sales",
    content:
      "Analyze monthly sales by region and product. Check missing values, describe the trend, and suggest useful charts.",
    createdBy: "fixture",
    source: "Generated",
    createdAt: "2026-10-25",
  },
  {
    id: "ver_data_sales_02",
    promptId: "prm_data_sales_01",
    number: 2,
    title: "Explore monthly sales",
    content:
      "Given monthly sales data with date, region, product, units, and revenue fields, profile missingness and duplicates before analysis. Summarize month-over-month changes by region and product; state assumptions, show calculations, and recommend a chart only if it helps compare trends. Do not infer missing observations.",
    createdBy: "fixture",
    source: "Optimized",
    createdAt: "2026-10-30",
    parentVersionId: "ver_data_sales_01",
  },
  {
    id: "ver_business_launch_01",
    promptId: "prm_business_launch_01",
    number: 1,
    title: "Launch planning brief",
    content:
      "Draft a launch plan for a small online language course. Identify audience assumptions, key milestones, and measures to review after launch.",
    createdBy: "fixture",
    source: "Generated",
    createdAt: "2026-10-24",
  },
  {
    id: "ver_research_claim_01",
    promptId: "prm_research_claim_01",
    number: 1,
    title: "Review a research claim",
    content:
      "Assess the claim that short retrieval practice improves long-term learning. Separate supporting evidence from unknowns and suggest search terms for primary studies.",
    createdBy: "fixture",
    source: "Generated",
    createdAt: "2026-10-23",
  },
  {
    id: "ver_agent_triage_01",
    promptId: "prm_agent_triage_01",
    number: 1,
    title: "Support ticket triage",
    content:
      "Classify each support ticket by urgency and topic. Ask for missing information when needed, never promise refunds, and hand off safety or billing disputes to a human.",
    createdBy: "fixture",
    source: "Generated",
    createdAt: "2026-10-22",
  },
  {
    id: "ver_general_notes_01",
    promptId: "prm_general_notes_01",
    number: 1,
    title: "Organize meeting notes",
    content:
      "Turn these meeting notes into a concise summary with decisions, owners, and open questions. Keep uncertain items marked as unconfirmed.",
    createdBy: "fixture",
    source: "Template",
    createdAt: "2026-10-19",
  },
];

export const prompts: Prompt[] = [
  [
    "prm_coding_csv_01",
    "Parse a CSV safely",
    "Coding",
    "ver_coding_csv_01",
    "PERSONAL_PROMPT",
    "Validate CSV input and return typed records.",
  ],
  [
    "prm_ui_checkout_01",
    "Checkout flow review",
    "UI/UX Design",
    "ver_ui_checkout_01",
    "TEMPLATE",
    "Review a mobile checkout experience.",
  ],
  [
    "prm_writing_course_01",
    "Three-day learning plan",
    "Writing",
    "ver_writing_course_03",
    "PERSONAL_PROMPT",
    "A beginner-friendly prompt engineering course outline.",
  ],
  [
    "prm_data_sales_01",
    "Explore monthly sales",
    "Data Analysis",
    "ver_data_sales_02",
    "PERSONAL_PROMPT",
    "Analyze regional sales with explicit data-quality handling.",
  ],
  [
    "prm_business_launch_01",
    "Launch planning brief",
    "Business",
    "ver_business_launch_01",
    "PERSONAL_PROMPT",
    "A measurable launch plan for a small online course.",
  ],
  [
    "prm_research_claim_01",
    "Review a research claim",
    "Research",
    "ver_research_claim_01",
    "PERSONAL_PROMPT",
    "Separate evidence, uncertainty, and follow-up research.",
  ],
  [
    "prm_agent_triage_01",
    "Support ticket triage",
    "AI Agent",
    "ver_agent_triage_01",
    "PERSONAL_PROMPT",
    "Triage with clear escalation and safety limits.",
  ],
  [
    "prm_general_notes_01",
    "Organize meeting notes",
    "General",
    "ver_general_notes_01",
    "TEMPLATE",
    "Create a concise, traceable meeting summary.",
  ],
].map(([id, title, taskType, currentVersionId, kind, description]) => ({
  id,
  title,
  taskType: taskType as TaskType,
  currentVersionId,
  kind: kind as Prompt["kind"],
  description,
  favorite: false,
}));

export const reports: EvaluationReport[] = [
  {
    id: "evr_writing_course_03",
    promptId: "prm_writing_course_01",
    versionId: "ver_writing_course_03",
    createdAt: "2026-10-29",
    source: "MOCK / SIMULATED",
    rubricVersion: "Layer 1 confirmed dimensions · illustrative static fixture",
    layer1: l1Mock([86, 78, 91, 82, 88, 76]),
    layer2: {
      status: "MOCK / SIMULATED",
      score: null,
      grade: null,
      dimensions: [
        {
          name: "Audience Fit",
          weight: 0,
          score: null,
          state: "QUALITATIVE MOCK",
          reason: "A beginner audience is explicitly named. No task score is calculated.",
        },
      ],
    },
    layer3: notExecuted,
  },
  {
    id: "evr_coding_csv_01",
    promptId: "prm_coding_csv_01",
    versionId: "ver_coding_csv_01",
    createdAt: "2026-10-28",
    source: "MOCK / SIMULATED",
    rubricVersion: "Coding mock example",
    layer1: l1Mock([84, 75, 88, 86, 90, 81]),
    layer2: {
      status: "MOCK / SIMULATED",
      score: null,
      grade: null,
      dimensions: [
        {
          name: "Input contract",
          weight: 0,
          score: null,
          state: "QUALITATIVE MOCK",
          reason:
            "Required columns and malformed-row behavior are named; correctness is not executed.",
        },
      ],
    },
    layer3: notExecuted,
  },
  {
    id: "evr_data_sales_02",
    promptId: "prm_data_sales_01",
    versionId: "ver_data_sales_02",
    createdAt: "2026-10-30",
    source: "MOCK / SIMULATED",
    rubricVersion: "Data Analysis rubric pending category review",
    layer1: l1Mock([80, 72, 82, 88, 78, 84]),
    layer2: { status: "PENDING REVIEW", score: null, grade: null, dimensions: [] },
    layer3: notExecuted,
  },
  {
    id: "evr_general_notes_01",
    promptId: "prm_general_notes_01",
    versionId: "ver_general_notes_01",
    createdAt: "2026-10-19",
    source: "MOCK / SIMULATED",
    rubricVersion: "General fallback",
    layer1: l1Mock([78, 70, 75, 80, 82, 74]),
    layer2: unavailable,
    layer3: notExecuted,
  },
];

export const suggestions: Suggestion[] = [
  {
    id: "opt_writing_course_01",
    title: "Add a worked example",
    rationale: "A concrete example helps beginners transfer the lesson into practice.",
    before: "a guided exercise",
    after: "a worked example followed by a guided exercise",
  },
  {
    id: "opt_writing_course_02",
    title: "Make the output sequence explicit",
    rationale: "A stable sequence makes the requested response easier to review.",
    before: "give a lesson and practice",
    after: "provide lesson, worked example, exercise, then reflection",
  },
];

export const createInitialState = (locale: "en" | "zh-CN" = "en"): AppState => ({
  prompts: structuredClone(prompts),
  versions: structuredClone(versions),
  reports: structuredClone(reports),
  libraryPromptIds: prompts.map((prompt) => prompt.id),
  history: [
    "ver_writing_course_01",
    "ver_writing_course_02",
    "ver_writing_course_03",
    "ver_data_sales_02",
  ].map((versionId, i) => ({
    id: `his_demo_${i + 1}`,
    promptId: versions.find((v) => v.id === versionId)!.promptId,
    versionId,
    source: versions.find((v) => v.id === versionId)!.source,
    createdAt: versions.find((v) => v.id === versionId)!.createdAt,
  })),
  draft: { promptId: null, title: "", content: "", taskType: "Writing" },
  suggestions: structuredClone(suggestions),
  locale,
  mode: "simple",
  tier: "Free",
  favorites: [],
  playgroundRuns: [],
  liveAdvice: [],
  profileName: "Alex Morgan",
  notice: null,
});

export function layerDefaults() {
  return { notExecuted, unavailable };
}
