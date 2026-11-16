import type {
  EvaluationReport,
  HistoryItem,
  LiveAdvice,
  Locale,
  ModelUsage,
  Prompt,
  PromptVersion,
  TaskType,
} from "./types";
import type { ModelQuotaSummary } from "./server/model/model-types";
import type { ModelProvider, ModelSelection, ModelStrength } from "./model-catalog";

export type RemoteSnapshot = {
  prompts: Prompt[];
  versions: PromptVersion[];
  reports: EvaluationReport[];
  history: HistoryItem[];
  libraryPromptIds: string[];
  favorites: string[];
  playgroundRuns: {
    createdAt?: string;
    modelEvidence?: import("./types").ModelExecutionEvidence;
    id: string;
    versionId: string;
    source?: string;
    executionId?: string;
    outputs: { name: string; text: string; source?: string }[];
  }[];
  liveAdvice: LiveAdvice[];
  profileName: string;
};

export type RemoteSnapshotResult =
  | { kind: "disabled" }
  | { kind: "ready"; snapshot: RemoteSnapshot }
  | { kind: "unavailable"; code: string };

export type RemoteMutationResult =
  { kind: "disabled" } | { kind: "ready"; data?: unknown } | { kind: "unavailable"; code: string };

export type LiveGenerationResponse = {
  executionMode: "LIVE";
  executionId: string;
  promptId: string;
  versionId: string;
  title: string;
  taskType: TaskType;
  content: string;
  provider: ModelProvider;
  strength?: ModelStrength;
  requestedModel: string;
  resolvedModel: string;
  productVersion: string;
  providerRequestId?: string;
  finishReason?: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    promptCacheHitTokens?: number;
    promptCacheMissTokens?: number;
    reasoningTokens?: number;
  };
  latencyMs: number;
};

export type LiveGenerationResult =
  | { kind: "ready"; data: LiveGenerationResponse }
  | { kind: "unavailable"; code: string; message: string; executionId?: string };

export type LiveSourceResponse = {
  evaluation?: import("./model-evaluation").ModelEvaluation;
  createdAt?: string;
  executionMode: "LIVE";
  purpose: "OPTIMIZATION" | "PLAYGROUND" | "EVALUATION_ADVICE" | "EVALUATION_REPORT";
  executionId: string;
  promptId: string;
  versionId: string;
  content: string;
  provider: ModelProvider;
  strength?: ModelStrength;
  requestedModel: string;
  resolvedModel: string;
  productVersion: string;
  providerRequestId?: string;
  finishReason?: string;
  usage: ModelUsage;
  latencyMs: number;
  optimizationId?: string;
  sessionId?: string;
};

export type LiveSourceResult =
  | { kind: "ready"; data: LiveSourceResponse }
  | { kind: "unavailable"; code: string; message: string; executionId?: string };

export type LiveQuotaResult =
  | { kind: "ready"; data: ModelQuotaSummary }
  | { kind: "unavailable"; code: string; message: string };

export function isRemoteDemoSyncEnabled() {
  return process.env.NEXT_PUBLIC_PROMPTMASTER_DEMO_API_ENABLED === "true";
}

export async function fetchLiveModelQuota(): Promise<LiveQuotaResult> {
  try {
    const response = await fetch("/api/ai/quota", { cache: "no-store" });
    const payload: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload as { error?: unknown; message?: unknown };
      return {
        kind: "unavailable",
        code: typeof detail.error === "string" ? detail.error : `HTTP_${response.status}`,
        message: typeof detail.message === "string" ? detail.message : "Quota data is unavailable.",
      };
    }
    return isModelQuotaSummary(payload)
      ? { kind: "ready", data: payload }
      : {
          kind: "unavailable",
          code: "INVALID_QUOTA_RESPONSE",
          message: "Quota data is incomplete.",
        };
  } catch {
    return { kind: "unavailable", code: "NETWORK_ERROR", message: "Quota data is unavailable." };
  }
}

function isModelQuotaSummary(value: unknown): value is ModelQuotaSummary {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  const amounts = [
    "dailyTokenLimit",
    "reservedTokens",
    "settledTokens",
    "usedTokens",
    "remainingTokens",
    "dailyCostLimitUsd",
    "reservedCostUsd",
    "settledCostUsd",
    "usedCostUsd",
    "remainingCostUsd",
    "pendingReconciliations",
    "periodTokenLimit",
    "periodCostLimitUsd",
    "periodSettledTokens",
    "periodReservedTokens",
    "periodRemainingTokens",
    "periodSettledCostUsd",
    "periodReservedCostUsd",
    "periodRemainingCostUsd",
  ];
  return (
    data.scope === "USER" &&
    (data.tierCode === "FREE_V1" || data.tierCode === "PRO_TEST_30D_V1") &&
    typeof data.frozen === "boolean" &&
    !!data.platform &&
    typeof data.platform === "object" &&
    ["dailyLimitUsd", "periodLimitUsd", "dailyUsedUsd", "periodUsedUsd"].every(
      (k) =>
        typeof (data.platform as Record<string, unknown>)[k] === "number" &&
        Number.isFinite((data.platform as Record<string, unknown>)[k]) &&
        ((data.platform as Record<string, unknown>)[k] as number) >= 0,
    ) &&
    typeof (data.platform as Record<string, unknown>).periodEnd === "string" &&
    typeof data.enabled === "boolean" &&
    data.currency === "USD" &&
    data.resetTimezone === "UTC" &&
    data.costBasis === "LOCAL_ESTIMATE" &&
    (data.pricingWindow === "PEAK" || data.pricingWindow === "OFF_PEAK") &&
    [
      "usageDay",
      "periodStart",
      "periodEnd",
      "pricingSourceUrl",
      "pricingModel",
      "pricingProductVersion",
      "pricingVerifiedAt",
      "pricingValidUntil",
    ].every((key) => typeof data[key] === "string") &&
    amounts.every(
      (key) => typeof data[key] === "number" && Number.isFinite(data[key]) && data[key] >= 0,
    )
  );
}

function isSnapshot(value: unknown): value is RemoteSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<RemoteSnapshot>;
  return (
    Array.isArray(snapshot.prompts) &&
    Array.isArray(snapshot.versions) &&
    Array.isArray(snapshot.reports) &&
    Array.isArray(snapshot.history) &&
    Array.isArray(snapshot.libraryPromptIds) &&
    Array.isArray(snapshot.favorites) &&
    Array.isArray(snapshot.playgroundRuns) &&
    Array.isArray(snapshot.liveAdvice) &&
    typeof snapshot.profileName === "string"
  );
}

export async function fetchRemoteSnapshot(signal?: AbortSignal): Promise<RemoteSnapshotResult> {
  if (!isRemoteDemoSyncEnabled()) return { kind: "disabled" };
  try {
    const response = await fetch("/api/demo/snapshot", {
      method: "GET",
      cache: "no-store",
      signal,
    });
    if (response.status === 404) return { kind: "disabled" };
    if (!response.ok) return { kind: "unavailable", code: `HTTP_${response.status}` };
    const payload: unknown = await response.json();
    return isSnapshot(payload)
      ? { kind: "ready", snapshot: payload }
      : { kind: "unavailable", code: "INVALID_SNAPSHOT" };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return { kind: "disabled" };
    return { kind: "unavailable", code: "NETWORK_ERROR" };
  }
}

export async function mutateRemoteDemo(
  path: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown,
  requestKey?: string,
): Promise<RemoteMutationResult> {
  if (!isRemoteDemoSyncEnabled()) return { kind: "disabled" };
  try {
    const response = await fetch(path, {
      method,
      cache: "no-store",
      headers:
        body === undefined
          ? undefined
          : {
              "Content-Type": "application/json",
              ...(requestKey ? { "Idempotency-Key": requestKey } : {}),
            },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 404) return { kind: "disabled" };
    if (!response.ok) {
      let code = `HTTP_${response.status}`;
      try {
        const payload = (await response.json()) as { error?: unknown };
        if (typeof payload.error === "string") code = payload.error;
      } catch {
        // Keep the status based code when the response is not JSON.
      }
      return { kind: "unavailable", code };
    }
    if (response.status === 204) return { kind: "ready" };
    try {
      return { kind: "ready", data: await response.json() };
    } catch {
      return { kind: "ready" };
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return { kind: "unavailable", code: "NETWORK_ERROR" };
  }
}

function isLiveGenerationResponse(value: unknown): value is LiveGenerationResponse {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<LiveGenerationResponse>;
  return (
    result.executionMode === "LIVE" &&
    typeof result.executionId === "string" &&
    typeof result.promptId === "string" &&
    typeof result.versionId === "string" &&
    typeof result.title === "string" &&
    typeof result.content === "string" &&
    (result.provider === "deepseek" || result.provider === "siliconflow") &&
    typeof result.requestedModel === "string" &&
    typeof result.resolvedModel === "string" &&
    typeof result.productVersion === "string" &&
    typeof result.latencyMs === "number" &&
    !!result.usage &&
    typeof result.usage.totalTokens === "number"
  );
}

export async function generateLivePrompt(
  input: ModelSelection & {
    goal: string;
    taskType?: TaskType;
    locale: Locale;
    descriptor?: import("./prompt-description").PromptDescriptor;
  },
  signal?: AbortSignal,
): Promise<LiveGenerationResult> {
  try {
    const response = await fetch("/api/ai/generate", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal,
    });
    const payload: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload as { error?: unknown; message?: unknown; executionId?: unknown };
      return {
        kind: "unavailable",
        code: typeof detail.error === "string" ? detail.error : `HTTP_${response.status}`,
        message:
          typeof detail.message === "string"
            ? detail.message
            : "The live model request could not be completed.",
        ...(typeof detail.executionId === "string" ? { executionId: detail.executionId } : {}),
      };
    }
    return isLiveGenerationResponse(payload)
      ? { kind: "ready", data: payload }
      : {
          kind: "unavailable",
          code: "INVALID_MODEL_RESPONSE",
          message: "The live model response was incomplete.",
        };
  } catch (error) {
    return {
      kind: "unavailable",
      code:
        error instanceof Error && error.name === "AbortError"
          ? "REQUEST_CANCELLED"
          : "NETWORK_ERROR",
      message:
        error instanceof Error && error.name === "AbortError"
          ? "The live model request was cancelled."
          : "The live model API could not be reached.",
    };
  }
}

function isLiveSourceResponse(value: unknown): value is LiveSourceResponse {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<LiveSourceResponse>;
  return (
    result.executionMode === "LIVE" &&
    ["OPTIMIZATION", "PLAYGROUND", "EVALUATION_ADVICE", "EVALUATION_REPORT"].includes(
      String(result.purpose),
    ) &&
    (result.purpose !== "EVALUATION_REPORT" || !!result.evaluation) &&
    typeof result.executionId === "string" &&
    typeof result.promptId === "string" &&
    typeof result.versionId === "string" &&
    typeof result.content === "string" &&
    (result.provider === "deepseek" || result.provider === "siliconflow") &&
    typeof result.resolvedModel === "string" &&
    typeof result.productVersion === "string" &&
    !!result.usage &&
    typeof result.usage.totalTokens === "number"
  );
}

async function runLiveSource(
  path: string,
  input: ModelSelection & {
    promptId: string;
    versionId: string;
    locale: Locale;
    requestKey?: string;
  },
): Promise<LiveSourceResult> {
  try {
    const response = await fetch(path, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const payload: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload as { error?: unknown; message?: unknown; executionId?: unknown };
      return {
        kind: "unavailable",
        code: typeof detail.error === "string" ? detail.error : `HTTP_${response.status}`,
        message:
          typeof detail.message === "string"
            ? detail.message
            : "The live model request could not be completed.",
        ...(typeof detail.executionId === "string" ? { executionId: detail.executionId } : {}),
      };
    }
    return isLiveSourceResponse(payload)
      ? { kind: "ready", data: payload }
      : {
          kind: "unavailable",
          code: "INVALID_MODEL_RESPONSE",
          message: "The live model response was incomplete.",
        };
  } catch {
    return {
      kind: "unavailable",
      code: "NETWORK_ERROR",
      message: "The live model API could not be reached.",
    };
  }
}

export function optimizeLivePrompt(
  input: ModelSelection & { promptId: string; versionId: string; locale: Locale },
) {
  return runLiveSource("/api/ai/optimize", input);
}

export type PlaygroundRunInput = ModelSelection & {
  promptId: string;
  versionId: string;
  locale: Locale;
  requestKey: string;
};

export function runLivePlayground(input: PlaygroundRunInput) {
  return runLiveSource("/api/ai/playground", input);
}

export type PlaygroundRequestStatus =
  | { status: "NOT_FOUND" }
  | { status: "PENDING" | "FAILED"; executionId: string; errorCode?: string }
  | { status: "SUCCEEDED"; executionId: string; result: LiveSourceResponse };
export type PlaygroundRequestResult =
  | { kind: "ready"; data: PlaygroundRequestStatus }
  | { kind: "unavailable"; code: string; message: string };

export async function fetchPlaygroundRequest(requestKey: string): Promise<PlaygroundRequestResult> {
  try {
    const response = await fetch(
      `/api/ai/playground?requestKey=${encodeURIComponent(requestKey)}`,
      { cache: "no-store" },
    );
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = payload as { error?: unknown; message?: unknown } | null;
      return {
        kind: "unavailable",
        code: typeof detail?.error === "string" ? detail.error : `HTTP_${response.status}`,
        message:
          typeof detail?.message === "string"
            ? detail.message
            : "Saved Playground status could not be recovered.",
      };
    }
    if (payload && typeof payload === "object") {
      const status = payload as Partial<PlaygroundRequestStatus>;
      if (status.status === "NOT_FOUND") return { kind: "ready", data: { status: "NOT_FOUND" } };
      if (
        (status.status === "PENDING" || status.status === "FAILED") &&
        typeof status.executionId === "string" &&
        (status.errorCode === undefined || typeof status.errorCode === "string")
      )
        return { kind: "ready", data: status as PlaygroundRequestStatus };
      if (
        status.status === "SUCCEEDED" &&
        typeof status.executionId === "string" &&
        isLiveSourceResponse(status.result) &&
        status.result.purpose === "PLAYGROUND" &&
        status.result.executionId === status.executionId
      )
        return { kind: "ready", data: status as PlaygroundRequestStatus };
    }
    return {
      kind: "unavailable",
      code: "INVALID_PLAYGROUND_STATUS",
      message: "The saved Playground status was incomplete.",
    };
  } catch {
    return {
      kind: "unavailable",
      code: "NETWORK_ERROR",
      message: "Saved Playground status could not be reached.",
    };
  }
}

export function generateLiveEvaluationAdvice(
  input: ModelSelection & {
    promptId: string;
    versionId: string;
    locale: Locale;
  },
) {
  return runLiveSource("/api/ai/evaluation-advice", input);
}

export function toLiveAdvice(result: LiveSourceResponse): LiveAdvice {
  return {
    ...(result.purpose === "EVALUATION_REPORT"
      ? { kind: "EVALUATION_REPORT" as const, evaluation: result.evaluation }
      : {}),
    id: `adv_${result.executionId}`,
    executionId: result.executionId,
    promptId: result.promptId,
    versionId: result.versionId,
    content: result.content,
    provider: result.provider,
    strength: result.strength,
    model: result.resolvedModel,
    productVersion: result.productVersion,
    usage: result.usage,
    createdAt: result.createdAt ?? new Date().toISOString(),
  };
}

export function generateLiveEvaluationReport(
  input: ModelSelection & {
    promptId: string;
    versionId: string;
    locale: Locale;
    requestKey: string;
  },
) {
  return runLiveSource("/api/ai/evaluation-report", input);
}
