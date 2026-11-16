import type { Locale, TaskType } from "@/lib/types";
import type { ModelProvider, ModelSelection, ModelStrength } from "@/lib/model-catalog";
import type { PromptDescriptor } from "@/lib/prompt-description";

export type ModelUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
  reasoningTokens?: number;
};

export type LiveModelConfig = {
  mode: "LIVE";
  provider: ModelProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  productVersion: string;
  timeoutMs: number;
  maxRetries: number;
  maxOutputTokens: number;
  dailyTokenLimit: number;
  dailyCostLimitUsd: number;
  pricingWindow: "AUTO" | "OFF_PEAK" | "PEAK";
  strength?: ModelStrength;
  reasoningTokenReserve?: number;
};

export type ModelConfig = { mode: "DISABLED" } | LiveModelConfig;

export type ModelRequestKind =
  "PROMPT_GENERATION" | "OPTIMIZATION" | "PLAYGROUND" | "EVALUATION_ADVICE" | "EVALUATION_REPORT";

export type ModelGenerateInput = ModelSelection & {
  descriptor?: PromptDescriptor;
  goal: string;
  taskType: TaskType;
  locale: Locale;
  kind?: ModelRequestKind;
  sourceContent?: string;
  // Server-loaded material only; never accepted as raw context by an HTTP route.
  skillContext?: string;
  taskPlanContext?: string;
  goalInSource?: boolean;
  skillPlanId?: string;
  skillRunId?: string;
  evaluationPrinciples?: ReturnType<
    typeof import("@/lib/model-evaluation").modelEvaluationPrinciples
  >;
  signal?: AbortSignal;
};

export type ModelMessage = Readonly<{ role: "system" | "user"; content: string }>;

export type ProviderGenerateResult = {
  content: string;
  resolvedModel: string;
  providerRequestId?: string;
  systemFingerprint?: string;
  finishReason?: string;
  usage: ModelUsage;
  latencyMs: number;
};

export type LivePromptGenerationResult = {
  executionMode: "LIVE";
  executionId: string;
  promptId: string;
  versionId: string;
  title: string;
  taskType: TaskType;
  content: string;
  provider: ModelProvider;
  requestedModel: string;
  resolvedModel: string;
  productVersion: string;
  strength?: ModelStrength;
  providerRequestId?: string;
  finishReason?: string;
  usage: ModelUsage;
  latencyMs: number;
};

export type LiveSourceModelResult = {
  evaluation?: import("@/lib/model-evaluation").ModelEvaluation;
  createdAt?: string;
  executionMode: "LIVE";
  purpose: Exclude<ModelRequestKind, "PROMPT_GENERATION">;
  executionId: string;
  promptId: string;
  versionId: string;
  content: string;
  provider: ModelProvider;
  requestedModel: string;
  resolvedModel: string;
  productVersion: string;
  strength?: ModelStrength;
  providerRequestId?: string;
  finishReason?: string;
  usage: ModelUsage;
  latencyMs: number;
  optimizationId?: string;
  sessionId?: string;
};

export type LiveEvaluationAdvice = {
  id: string;
  executionId: string;
  promptId: string;
  versionId: string;
  content: string;
  provider: ModelProvider;
  model: string;
  productVersion: string;
  usage: ModelUsage;
  createdAt: string;
};

export type ModelQuotaSummary = {
  scope: "USER";
  tierCode: "FREE_V1" | "PRO_TEST_30D_V1";
  unlimited?: boolean;
  enabled: boolean;
  usageDay: string;
  resetTimezone: "UTC";
  dailyTokenLimit: number;
  reservedTokens: number;
  settledTokens: number;
  usedTokens: number;
  remainingTokens: number;
  dailyCostLimitUsd: number;
  reservedCostUsd: number;
  baseDailyCostLimitUsd?: number;
  dailyCostAllowance?: { dailyCostLimitUsd: number; expiresAt: string } | null;
  settledCostUsd: number;
  usedCostUsd: number;
  remainingCostUsd: number;
  currency: "USD";
  pricingWindow: "OFF_PEAK" | "PEAK";
  pricingSourceUrl: string;
  pricingModel: string;
  pricingProductVersion: string;
  pricingVerifiedAt: string;
  pricingValidUntil: string;
  costBasis: "LOCAL_ESTIMATE";
  pendingReconciliations: number;
  periodStart: string;
  periodEnd: string;
  periodTokenLimit: number;
  periodCostLimitUsd: number;
  periodSettledTokens: number;
  periodReservedTokens: number;
  periodRemainingTokens: number;
  periodSettledCostUsd: number;
  periodReservedCostUsd: number;
  periodRemainingCostUsd: number;
  frozen: boolean;
  platform: {
    dailyLimitUsd: number;
    periodLimitUsd: number;
    dailyUsedUsd: number;
    periodUsedUsd: number;
    periodEnd: string;
  };
};
