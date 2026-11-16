import type { TaskType } from "./types";

export type Bilingual = { en: string; "zh-CN": string };
export const copy = (en: string, zh: string): Bilingual => ({ en, "zh-CN": zh });
export const CALIBRATION_VERSION = "L1-CAL-11B-1.0.0";
export type IndicatorDefinition = { id: string; name: Bilingual; checkpoint: Bilingual };
export type DimensionDefinition = {
  id: string;
  name: Bilingual;
  weight: number;
  indicators: IndicatorDefinition[];
};

const dimension = (
  id: string,
  en: string,
  zh: string,
  weight: number,
  indicators: [string, string, string, string][],
): DimensionDefinition => ({
  id,
  name: copy(en, zh),
  weight,
  indicators: indicators.map(([name, label, guide, explanation], index) => ({
    id: `${id}_I${index + 1}`,
    name: copy(name, label),
    checkpoint: copy(guide, explanation),
  })),
});

// Indicator weights are 25% within each L1 dimension. Checkpoints carry no weights.
export const layer1Rubric: DimensionDefinition[] = [
  dimension("L1_D1", "Goal Clarity", "目标清晰度", 20, [
    [
      "Goal",
      "目标",
      "Can the requested task be identified without guessing?",
      "无需猜测即可理解要完成的任务吗？",
    ],
    ["Deliverable", "成果", "Is the intended result identifiable?", "预期交付成果是否可以识别？"],
    [
      "Role",
      "角色",
      "If a specific responsibility is needed, is it clear? Otherwise explain N/A.",
      "仅在需要特定职责时检查角色；否则说明不适用。",
    ],
    [
      "Scope",
      "任务范围",
      "Are the relevant subject and scope clear?",
      "相关对象与任务范围是否清楚？",
    ],
  ]),
  dimension("L1_D2", "Context Completeness", "上下文完整性", 20, [
    [
      "Background",
      "背景",
      "Is necessary background available? Do not demand irrelevant context.",
      "是否提供必要背景？不要求无关上下文。",
    ],
    [
      "Inputs",
      "输入",
      "Are required inputs or a way to obtain them specified? Unreadable files are unknown, not proven defects.",
      "必要输入或获取安排是否明确？不可读附件是未知，不是已证缺陷。",
    ],
    [
      "Audience",
      "受众",
      "Is the audience clear when it changes the response?",
      "受众影响回答时，是否明确受众？",
    ],
    [
      "Prerequisites",
      "前置条件",
      "Are relevant assumptions and prerequisites identified?",
      "相关假设和前置条件是否明确？",
    ],
  ]),
  dimension("L1_D3", "Instruction Structure", "指令结构", 15, [
    [
      "Organization",
      "组织",
      "Can instructions be followed? A short task need not use headings.",
      "指令是否容易理解？短任务无需强制标题。",
    ],
    [
      "Priority",
      "优先级",
      "Where requirements compete, is priority explicit?",
      "存在竞争要求时，优先级是否清楚？",
    ],
    [
      "Workflow",
      "流程",
      "Are necessary steps/dependencies clear? A single task need not have multiple steps.",
      "必要步骤和依赖是否清楚？单一任务无需强制多步骤。",
    ],
    [
      "Consistency",
      "一致性",
      "Are instructions compatible, or are conflicts resolved? Attribute each defect once.",
      "要求是否兼容或有冲突处理？同一缺陷避免重复扣分。",
    ],
  ]),
  dimension("L1_D4", "Constraints & Boundaries", "约束与边界", 15, [
    [
      "Scope constraints",
      "范围约束",
      "Are required limits clear and relevant?",
      "必要范围限制是否清晰且相关？",
    ],
    [
      "Resources",
      "资源",
      "Are relevant resource limits stated? Do not demand budgets or a stack unnecessarily.",
      "相关资源限制是否说明？不强制无关预算或技术栈。",
    ],
    [
      "Exceptions",
      "异常",
      "Does the task address relevant missing input, conflict or failure conditions?",
      "是否安排相关缺输入、冲突或失败的处理？",
    ],
    [
      "Prohibitions",
      "禁止事项",
      "Are necessary safety or authorization boundaries observable?",
      "必要安全和授权边界是否可观察？",
    ],
  ]),
  dimension("L1_D5", "Output Specification", "输出规范", 15, [
    [
      "Format",
      "格式",
      "Is a usable output format explicit or unambiguous from the task?",
      "输出格式是否明确，或由任务本身唯一确定？",
    ],
    ["Content", "内容", "Are necessary output elements clear?", "必要输出内容是否清楚？"],
    [
      "Granularity",
      "粒度",
      "Is appropriate detail/length clear where it matters?",
      "细节或长度影响任务时，要求是否适当？",
    ],
    [
      "Usability",
      "可用性",
      "Can the recipient use the requested result for the stated purpose?",
      "所要求结果是否便于接收者用于既定目的？",
    ],
  ]),
  dimension("L1_D6", "Precision & Verifiability", "精确性与可验证性", 15, [
    [
      "Accuracy requirements",
      "准确性要求",
      "Are claims, assumptions and accuracy expectations explicit where needed?",
      "必要的事实、假设及准确性要求是否清楚？",
    ],
    [
      "Sources",
      "来源",
      "Are relevant source/traceability requirements stated? Do not claim sources were checked.",
      "相关来源和追溯要求是否明确？不得宣称来源已核验。",
    ],
    [
      "Acceptance",
      "验收",
      "Can the requested result be checked against the task?",
      "结果是否能对照任务要求检查？",
    ],
    [
      "Uncertainty",
      "不确定性",
      "Are uncertain/unverified items handled explicitly where relevant?",
      "相关不确定或未验证事项是否有明确处理？",
    ],
  ]),
];

export const anchors = [
  {
    id: "Q5",
    score: 95,
    name: copy(
      "Material requirements are clear and actionable",
      "实质要求明确、可操作且无关键证据缺口",
    ),
  },
  {
    id: "Q4",
    score: 85,
    name: copy("Core met; minor ambiguity", "核心满足，存在不妨碍执行的小歧义"),
  },
  {
    id: "Q3",
    score: 70,
    name: copy("Direction clear; observable gaps", "方向明确，存在需要补充的可见缺口"),
  },
  {
    id: "Q2",
    score: 50,
    name: copy("Proven defects affect main task", "已证缺陷影响主要任务，部分内容可用"),
  },
  { id: "Q1", score: 20, name: copy("Proven severe failure", "证据表明相关职责存在严重失败") },
] as const;

type Candidate = { name: Bilingual; weight: number; checkpoints: Bilingual };
const candidate = (
  en: string,
  zh: string,
  weight: number,
  guide: string,
  explanation: string,
): Candidate => ({ name: copy(en, zh), weight, checkpoints: copy(guide, explanation) });
// Read-only experimental profiles; no Layer 2 scoring formula is enabled.
export const candidateLayer2: Partial<Record<TaskType, Candidate[]>> = {
  "Data Analysis": [
    candidate(
      "Source Fields",
      "来源与字段",
      15,
      "Source/access; fields, units, grain and time window",
      "来源与获取安排；字段、单位、粒度与时间口径",
    ),
    candidate(
      "Objective & Method",
      "目标与方法",
      25,
      "Answerable question; metrics, method and assumptions",
      "可回答的问题；目标指标、方法与假设边界",
    ),
    candidate(
      "Data Quality Handling",
      "数据质量处理",
      25,
      "Missing values, outliers, duplicates, bias and transformation log",
      "缺失、异常、重复、偏差与清洗转换记录",
    ),
    candidate(
      "Result Interpretation & Presentation",
      "结果解释与呈现",
      20,
      "Evidence, limitations and presentation suited to audience",
      "依据、局限及适合受众的呈现方式",
    ),
    candidate(
      "Validation & Reproducibility",
      "验证与可复现性",
      15,
      "Cross-checks, failure disclosure, steps and version records",
      "交叉复核、失败披露、步骤和版本记录",
    ),
  ],
  Business: [
    candidate(
      "Business Objective & Decision",
      "业务目标与决策",
      25,
      "Decision, action, success criteria and time boundary",
      "决策、行动、成功标准与时间边界",
    ),
    candidate(
      "Stakeholders & Context",
      "利益相关者与情境",
      15,
      "Decision makers, affected parties, facts and assumptions",
      "决策者、受影响方、事实与假设",
    ),
    candidate(
      "Options & Trade-offs",
      "方案与取舍",
      20,
      "Relevant alternatives; consistent criteria and opportunity costs",
      "相关可选方案；一致比较标准与机会成本",
    ),
    candidate(
      "Feasibility & Risk",
      "可行性与风险",
      20,
      "Resources, dependencies, risks, mitigation and uncertainty",
      "资源、依赖、风险、缓解及不确定性",
    ),
    candidate(
      "Metrics & Recommendation",
      "指标与建议",
      20,
      "Metric definitions, monitoring and evidence-based conditional action",
      "指标定义、监测及有依据的条件性行动",
    ),
  ],
  Research: [
    candidate(
      "Research Question & Scope",
      "研究问题与范围",
      20,
      "Question, population, time, exclusions and purpose",
      "问题、对象、时间、排除边界与目的",
    ),
    candidate(
      "Source Quality & Traceability",
      "来源质量与可追溯性",
      25,
      "Source criteria, recency, citations and missing-source disclosure",
      "来源标准、时效、引用与缺来源披露",
    ),
    candidate(
      "Method & Selection",
      "方法与选择",
      20,
      "Search, inclusion/exclusion, bias and replicable method",
      "检索、纳入排除、偏差与可复核方法",
    ),
    candidate(
      "Analysis & Synthesis",
      "分析与综合",
      20,
      "Cross-source synthesis, facts vs inference and conflicting evidence",
      "跨来源综合、事实与推断、冲突证据",
    ),
    candidate(
      "Conclusions & Limitations",
      "结论与局限",
      15,
      "Evidence-bounded conclusions, gaps and next validation",
      "证据边界内结论、空白与后续验证",
    ),
  ],
  "AI Agent": [
    candidate(
      "Agent Role & Goal",
      "Agent 角色与目标",
      15,
      "Role, deliverables, non-goals and completion conditions",
      "职责、成果、非目标与完成条件",
    ),
    candidate(
      "Tools & Permissions",
      "工具与权限",
      25,
      "Tool contracts, data scope and approval for impactful actions",
      "工具契约、数据范围与高影响动作确认",
    ),
    candidate(
      "Workflow & Decision Logic",
      "流程与决策逻辑",
      25,
      "Steps, branches, dependencies, decisions and stopping",
      "步骤、分支、依赖、决策与停止条件",
    ),
    candidate(
      "State & Error Recovery",
      "状态与错误恢复",
      20,
      "Handoff, idempotency, bounded retries and recovery",
      "交接、幂等、有限重试与恢复",
    ),
    candidate(
      "Safety & Human Oversight",
      "安全与人工监督",
      15,
      "Untrusted input, sensitive data, human stop rights and audit",
      "不可信输入、敏感数据、人工停止权与审计",
    ),
  ],
};
