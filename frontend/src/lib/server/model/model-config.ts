import "server-only";
import { ModelServiceError } from "./model-errors";
import type { LiveModelConfig, ModelConfig } from "./model-types";
import { PRO_PLAN } from "@/lib/billing-policy";
import {
  catalogModel,
  modelOutputLimit,
  validModelSelection,
  type ModelSelection,
} from "@/lib/model-catalog";

type Environment = Record<string, string | undefined>;

function required(env: Environment, name: string) {
  const value = env[name]?.trim();
  if (!value) {
    throw new ModelServiceError(
      "MODEL_CONFIGURATION_ERROR",
      `${name} is required for live model execution.`,
      503,
    );
  }
  return value;
}

function integerSetting(
  env: Environment,
  name: string,
  fallback: number,
  min: number,
  max: number,
) {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ModelServiceError(
      "MODEL_CONFIGURATION_ERROR",
      `${name} must be an integer between ${min} and ${max}.`,
      503,
    );
  }
  return value;
}

function decimalSetting(
  env: Environment,
  name: string,
  fallback: number,
  min: number,
  max: number,
) {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ModelServiceError(
      "MODEL_CONFIGURATION_ERROR",
      `${name} must be a number between ${min} and ${max}.`,
      503,
    );
  }
  return value;
}

function pricingWindowSetting(env: Environment) {
  const value = env.PROMPTMASTER_MODEL_PRICING_WINDOW?.trim().toUpperCase() ?? "AUTO";
  if (value !== "AUTO" && value !== "OFF_PEAK" && value !== "PEAK") {
    throw new ModelServiceError(
      "MODEL_CONFIGURATION_ERROR",
      "PROMPTMASTER_MODEL_PRICING_WINDOW must be auto, off_peak or peak.",
      503,
    );
  }
  return value as "AUTO" | "OFF_PEAK" | "PEAK";
}

export function readQuotaDefaults(env: Environment = process.env) {
  return {
    dailyTokenLimit: integerSetting(
      env,
      "PROMPTMASTER_MODEL_DAILY_TOKEN_LIMIT",
      PRO_PLAN.dailyTokens,
      1,
      100000000,
    ),
    dailyCostLimitUsd: decimalSetting(
      env,
      "PROMPTMASTER_MODEL_DAILY_COST_LIMIT_USD",
      // Operational ceilings; the actual Free/Pro plan is enforced separately.
      PRO_PLAN.dailyUsd,
      0,
      1000000,
    ),
    pricingWindow: pricingWindowSetting(env),
  };
}

export function readModelOutputCeiling(env: Environment = process.env, modelKey?: string) {
  void env; // Legacy output-ceiling environment variables no longer cap new calls.
  return modelOutputLimit(modelKey);
}

export function readModelConfig(
  env: Environment = process.env,
  selection: ModelSelection = {},
  task: Record<string, unknown> = {},
): ModelConfig {
  void task; // Kept for workflow call compatibility; task size no longer lowers output.
  if (!validModelSelection(selection))
    throw new ModelServiceError(
      "INVALID_MODEL_SELECTION",
      "The model or reasoning strength is not in the supported registry.",
      400,
    );
  const mode = env.PROMPTMASTER_MODEL_MODE?.trim().toLowerCase() ?? "disabled";
  if (mode === "disabled" || mode === "") return { mode: "DISABLED" };
  if (mode !== "live") {
    throw new ModelServiceError(
      "MODEL_CONFIGURATION_ERROR",
      "PROMPTMASTER_MODEL_MODE must be disabled or live.",
      503,
    );
  }

  const selected = catalogModel(selection.modelKey)!;
  const ceiling = readModelOutputCeiling(env, selected.key);
  if (selection.maxOutputTokens !== undefined && selection.maxOutputTokens > ceiling)
    throw new ModelServiceError(
      "MODEL_OUTPUT_LIMIT_EXCEEDED",
      "Requested output exceeds the server limit.",
      400,
    );
  const strength = selection.strength ?? selected.defaultStrength;
  // Normalize old clients too; role, task size and saved lower choices do not reduce new calls.
  const maxOutputTokens = ceiling;
  if (selected.provider === "siliconflow") {
    const baseUrl =
      env.SILICONFLOW_BASE_URL?.trim().replace(/\/+$/, "") ?? "https://api.siliconflow.cn/v1";
    if (baseUrl !== "https://api.siliconflow.cn/v1")
      throw new ModelServiceError(
        "MODEL_CONFIGURATION_ERROR",
        "SiliconFlow must use the approved HTTPS /v1 endpoint.",
        503,
      );
    return {
      mode: "LIVE",
      provider: "siliconflow",
      apiKey: required(env, "SILICONFLOW_API_KEY"),
      baseUrl,
      model: selected.model,
      productVersion: selected.model,
      strength,
      maxOutputTokens,
      // Reserve reasoning conservatively, including Hy4 whose deployment schema
      // counts it inside max_tokens. This estimate is not a provider billing cap.
      reasoningTokenReserve: strength === "off" ? 0 : 32768,
      // Reasoning/queued SiliconFlow calls can outlast the legacy direct-provider
      // 30s deadline. Keep its deadline independent from the DeepSeek setting.
      timeoutMs: integerSetting(env, "SILICONFLOW_MODEL_TIMEOUT_MS", 300000, 1000, 600000),
      maxRetries: 0,
      ...readQuotaDefaults(env),
      pricingWindow: "PEAK",
    };
  }
  const provider = required(env, "PROMPTMASTER_MODEL_PROVIDER").toLowerCase();
  if (provider !== "deepseek") {
    throw new ModelServiceError(
      "MODEL_CONFIGURATION_ERROR",
      "Only the deepseek provider is enabled in Stage 13A-1.",
      503,
    );
  }

  const rawBaseUrl = required(env, "DEEPSEEK_BASE_URL");
  let baseUrl: URL;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    throw new ModelServiceError(
      "MODEL_CONFIGURATION_ERROR",
      "DEEPSEEK_BASE_URL must be a valid URL.",
      503,
    );
  }
  if (baseUrl.protocol !== "https:") {
    throw new ModelServiceError(
      "MODEL_CONFIGURATION_ERROR",
      "DEEPSEEK_BASE_URL must use HTTPS.",
      503,
    );
  }

  const config: LiveModelConfig = {
    mode: "LIVE",
    provider: "deepseek",
    apiKey: required(env, "DEEPSEEK_API_KEY"),
    baseUrl: rawBaseUrl.replace(/\/+$/, ""),
    model: required(env, "DEEPSEEK_MODEL"),
    productVersion: required(env, "DEEPSEEK_PRODUCT_VERSION"),
    timeoutMs: integerSetting(env, "PROMPTMASTER_MODEL_TIMEOUT_MS", 30000, 1000, 120000),
    maxRetries: integerSetting(env, "PROMPTMASTER_MODEL_MAX_RETRIES", 2, 0, 5),
    maxOutputTokens,
    strength,
    reasoningTokenReserve: 0,
    ...readQuotaDefaults(env),
  };
  if (strength !== "off")
    config.timeoutMs = Math.max(
      config.timeoutMs,
      300000,
      integerSetting(env, "PROMPTMASTER_DEEPSEEK_THINKING_TIMEOUT_MS", 300000, 1000, 600000),
    );
  else if (maxOutputTokens > 8192) config.timeoutMs = Math.max(config.timeoutMs, 120000);
  return config;
}

export function publicModelConfig(config: ModelConfig) {
  if (config.mode === "DISABLED") return { mode: "DISABLED" as const, configured: false };
  return {
    mode: "LIVE" as const,
    configured: true,
    provider: config.provider,
    model: config.model,
    productVersion: config.productVersion,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    maxOutputTokens: config.maxOutputTokens,
    dailyTokenLimit: config.dailyTokenLimit,
    dailyCostLimitUsd: config.dailyCostLimitUsd,
    pricingWindow: config.pricingWindow,
    strength: config.strength,
    reasoningTokenReserve: config.reasoningTokenReserve ?? 0,
  };
}
