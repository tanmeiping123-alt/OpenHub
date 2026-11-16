// Public capability registry: no credentials or server environment reads.
export type ModelProvider = "deepseek" | "siliconflow";
export type ModelStrength = "default" | "off" | "low" | "high" | "max";
export type ModelSelection = {
  modelKey?: string;
  strength?: ModelStrength;
  maxOutputTokens?: number;
};
export const DEFAULT_PROMPT_MODEL_KEY = "deepseek-direct";
export type PublicModelOption = {
  key: string;
  configured: boolean;
  maxOutputTokens?: number;
  timeoutMs?: number;
  thinkingTimeoutMs?: number;
  pricing?: {
    currency: "CNY";
    inputPerMillion: number;
    outputPerMillion: number;
    cacheHitPerMillion: number;
    budgetUsdPerUnit: number;
    sourceUrl: string;
    validUntil: string;
  };
};
export const MODEL_CATALOG = [
  {
    key: "deepseek-direct",
    provider: "deepseek",
    model: "deepseek-flash",
    name: "DeepSeek-V4.1-Flash-1017",
    strengths: ["off", "low", "high", "max"],
    defaultStrength: "off",
  },
  {
    key: "zai-org/GLM-5.3-Flash",
    provider: "siliconflow",
    model: "zai-org/GLM-5.3-Flash",
    name: "GLM-5.3-Flash",
    // SiliconFlow model page lists reasoning effort low/high/max; default omits the parameter.
    strengths: ["default", "low", "high", "max"],
    defaultStrength: "default",
  },
  {
    key: "tencent/Hy4-preview",
    provider: "siliconflow",
    model: "tencent/Hy4-preview",
    name: "Hy4-preview",
    // SiliconFlow exposes no_think and high; default leaves the provider default untouched.
    strengths: ["default", "off", "high"],
    defaultStrength: "default",
  },
  {
    key: "zai-org/GLM-5.3",
    provider: "siliconflow",
    model: "zai-org/GLM-5.3",
    name: "GLM-5.3",
    // Always-on reasoning. Keep default to replay historical frozen requests.
    strengths: ["default", "low", "high", "max"],
    defaultStrength: "default",
  },
  {
    key: "deepseek-ai/DeepSeek-V4-Pro",
    provider: "siliconflow",
    model: "deepseek-ai/DeepSeek-V4-Pro",
    name: "DeepSeek-V4-Pro",
    strengths: ["off", "high", "max"],
    defaultStrength: "off",
  },
] as const;
export function catalogModel(key = DEFAULT_PROMPT_MODEL_KEY) {
  return MODEL_CATALOG.find((item) => item.key === key);
}
// Provider request parameter maxima verified on 2026-11-11 model pages.
// Hy4-preview treats max_tokens as completion tokens, including reasoning.
const SILICONFLOW_OUTPUT_LIMITS: Record<string, number> = {
  "zai-org/GLM-5.3": 262144,
  "zai-org/GLM-5.3-Flash": 262144,
  "tencent/Hy4-preview": 262144,
  "deepseek-ai/DeepSeek-V4-Pro": 393216,
};
export function modelOutputLimit(modelKey?: string) {
  const key = modelKey ?? DEFAULT_PROMPT_MODEL_KEY;
  if (key === "deepseek-direct") return 393216;
  return SILICONFLOW_OUTPUT_LIMITS[key] ?? 8192;
}
export function validModelSelection(value: Record<string, unknown>) {
  if (
    [
      "provider",
      "apiKey",
      "api_key",
      "baseUrl",
      "base_url",
      "endpoint",
      "model",
      "reasoning_effort",
      "thinking_budget",
      "enable_thinking",
    ].some((key) => key in value)
  )
    return false;
  if (
    value.modelKey !== undefined &&
    (typeof value.modelKey !== "string" || !catalogModel(value.modelKey))
  )
    return false;
  const model = catalogModel(value.modelKey as string | undefined)!;
  if (
    value.strength !== undefined &&
    !(model.strengths as readonly unknown[]).includes(value.strength)
  )
    return false;
  return (
    value.maxOutputTokens === undefined ||
    (Number.isInteger(value.maxOutputTokens) &&
      Number(value.maxOutputTokens) >= 1 &&
      Number(value.maxOutputTokens) <= modelOutputLimit(model.key))
  );
}

// Pick only public selectors. Connection credentials and capabilities remain server-owned.
export function modelSelection(value: Record<string, unknown>): ModelSelection {
  return {
    ...(value.modelKey !== undefined ? { modelKey: value.modelKey as string } : {}),
    ...(value.strength !== undefined ? { strength: value.strength as ModelStrength } : {}),
    ...(value.maxOutputTokens !== undefined
      ? { maxOutputTokens: value.maxOutputTokens as number }
      : {}),
  };
}
// Restored selections may omit a strength; never merge another model's default.
export function initialModelSelection(initial?: ModelSelection): ModelSelection {
  const selected = initial && validModelSelection(initial) ? modelSelection(initial) : {};
  const model = catalogModel(selected.modelKey)!;
  return {
    modelKey: model.key,
    strength: selected.strength ?? model.defaultStrength,
    ...(selected.maxOutputTokens !== undefined
      ? { maxOutputTokens: selected.maxOutputTokens }
      : {}),
  };
}
export function liveSource(
  provider: ModelProvider,
  kind: "GENERATION" | "OPTIMIZATION" | "PLAYGROUND",
) {
  return `${provider.toUpperCase()}_LIVE_${kind}`;
}
