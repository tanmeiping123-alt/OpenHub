export type Locale = "en" | "zh-CN";
export type Mode = "simple" | "professional";
export type TaskType =
  | "Coding"
  | "UI/UX Design"
  | "Writing"
  | "Data Analysis"
  | "Business"
  | "Research"
  | "AI Agent"
  | "General";
export type PromptVersion = {
  modelEvidence?: ModelExecutionEvidence;
  id: string;
  promptId: string;
  number: number;
  content: string;
  title: string;
  createdBy: string;
  source: string;
  createdAt: string;
  parentVersionId?: string;
};
export type Prompt = {
  descriptor?: import("./prompt-description").PromptDescriptor;
  id: string;
  title: string;
  taskType: TaskType;
  currentVersionId: string;
  kind: "TEMPLATE" | "PERSONAL_PROMPT";
  description: string;
  favorite: boolean;
};
export type LayerState = {
  status: string;
  score: number | null;
  grade: string | null;
  dimensions: {
    name: string;
    weight: number;
    score: number | null;
    state: string;
    reason: string;
  }[];
};
export type EvaluationReport = {
  id: string;
  promptId: string;
  versionId: string;
  createdAt: string;
  source: "MOCK / SIMULATED" | "LOCAL_HUMAN_CALIBRATION";
  calibration?: import("./calibration").CalibrationSnapshot;
  rubricVersion: string;
  layer1: LayerState;
  layer2: LayerState;
  layer3: LayerState;
};
export type HistoryItem = {
  id: string;
  promptId: string;
  versionId: string;
  source: string;
  createdAt: string;
};
export type Suggestion = {
  id: string;
  title: string;
  rationale: string;
  before: string;
  after: string;
};
export type ModelUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
  reasoningTokens?: number;
};
export type LiveAdvice = {
  kind?: "EVALUATION_REPORT";
  evaluation?: import("./model-evaluation").ModelEvaluation;
  id: string;
  executionId: string;
  promptId: string;
  versionId: string;
  content: string;
  provider: import("./model-catalog").ModelProvider;
  strength?: import("./model-catalog").ModelStrength;
  model: string;
  productVersion: string;
  usage: ModelUsage;
  createdAt: string;
};
export type ModelExecutionEvidence = {
  finishReason?: string;
  latencyMs?: number;
  createdAt?: string;
  executionId: string;
  provider: import("./model-catalog").ModelProvider;
  resolvedModel: string;
  requestedModel: string;
  strength?: import("./model-catalog").ModelStrength;
  usage: ModelUsage;
};
export type AppState = {
  prompts: Prompt[];
  versions: PromptVersion[];
  reports: EvaluationReport[];
  history: HistoryItem[];
  libraryPromptIds: string[];
  draft: {
    descriptor?: import("./prompt-description").PromptDescriptor;
    creationRequest?: {
      descriptor?: import("./prompt-description").PromptDescriptor;
      key: string;
      title: string;
      taskType: TaskType;
      content: string;
      manualDraft: boolean;
      adoptedUseEventIds?: string[];
    };
    adoptedUseEventIds?: string[];
    savedCreation?: { promptId: string; versionId: string };
    promptId: string | null;
    content: string;
    title: string;
    taskType: TaskType;
    parentVersionId?: string;
  };
  suggestions: Suggestion[];
  locale: Locale;
  mode: Mode;
  tier: "Free" | "Pro";
  favorites: string[];
  playgroundRuns: {
    createdAt?: string;
    modelEvidence?: ModelExecutionEvidence;
    id: string;
    versionId: string;
    source?: string;
    executionId?: string;
    outputs: { name: string; text: string; source?: string }[];
  }[];
  liveAdvice: LiveAdvice[];
  profileName: string;
  notice: string | null;
};
export type Action =
  | { type: "SET_LOCALE"; locale: Locale }
  | { type: "SET_MODE"; mode: Mode }
  | { type: "SET_TIER"; tier: "Free" | "Pro" }
  | { type: "SET_DRAFT"; patch: Partial<AppState["draft"]> }
  | { type: "LOAD_PROMPT"; promptId: string }
  | {
      type: "GENERATE";
      title: string;
      taskType: TaskType;
      content: string;
      descriptor?: import("./prompt-description").PromptDescriptor;
    }
  | {
      type: "CREATE_MANUAL_PROMPT";
      title: string;
      taskType: TaskType;
      content: string;
      descriptor?: import("./prompt-description").PromptDescriptor;
    }
  | {
      type: "SAVE_VERSION";
      title?: string;
      baseVersionId?: string;
      parentVersionId?: string;
      source: string;
      promptId?: string;
      content?: string;
      optimizationId?: string;
      descriptor?: import("./prompt-description").PromptDescriptor;
    }
  | { type: "RESTORE_VERSION"; promptId: string; versionId: string }
  | { type: "TOGGLE_FAVORITE"; promptId: string }
  | { type: "SAVE_TO_LIBRARY"; promptId: string }
  | { type: "REMOVE_FROM_LIBRARY"; promptId: string }
  | { type: "EVALUATE"; promptId: string; versionId: string }
  | {
      type: "CALIBRATE";
      promptId: string;
      versionId: string;
      assessments: import("./calibration").Assessment[];
    }
  | { type: "OPTIMIZE"; promptId: string; content: string }
  | { type: "PLAYGROUND"; versionId: string }
  | { type: "SET_PROFILE"; name: string }
  | { type: "HYDRATE"; saved: Partial<AppState> }
  | { type: "NOTICE"; message: string | null }
  | { type: "RESET" };
