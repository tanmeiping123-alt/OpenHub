import { describe, expect, it } from "vitest";
import { ModelServiceError } from "./model-errors";
import {
  publicModelConfig,
  readModelConfig,
  readQuotaDefaults,
  readModelOutputCeiling,
} from "./model-config";
import { initialModelSelection, modelOutputLimit, validModelSelection } from "@/lib/model-catalog";

function liveEnv(): Record<string, string | undefined> {
  return {
    PROMPTMASTER_MODEL_MODE: "live",
    PROMPTMASTER_MODEL_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "test-secret-value",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    DEEPSEEK_MODEL: "deepseek-flash",
    DEEPSEEK_PRODUCT_VERSION: "DeepSeek-V4.1-Flash-1017",
    PROMPTMASTER_MODEL_TIMEOUT_MS: "30000",
    PROMPTMASTER_MODEL_MAX_RETRIES: "2",
    PROMPTMASTER_MODEL_MAX_OUTPUT_TOKENS: "1200",
    PROMPTMASTER_MODEL_DAILY_TOKEN_LIMIT: "100000",
    PROMPTMASTER_MODEL_DAILY_COST_LIMIT_USD: "5",
    PROMPTMASTER_MODEL_PRICING_WINDOW: "auto",
  };
}

describe("model configuration", () => {
  it("offers only verified per-model reasoning tiers and restores them exactly", () => {
    for (const strength of ["default", "low", "high", "max"] as const) {
      const selection = { modelKey: "zai-org/GLM-5.3", strength };
      expect(validModelSelection(selection)).toBe(true);
      expect(initialModelSelection(selection)).toEqual(selection);
      expect(
        readModelConfig({ ...liveEnv(), SILICONFLOW_API_KEY: "synthetic" }, selection),
      ).toMatchObject({ strength, reasoningTokenReserve: 32768 });
    }
    expect(validModelSelection({ modelKey: "zai-org/GLM-5.3", strength: "off" })).toBe(false);
    for (const strength of ["default", "low", "high", "max"] as const)
      expect(validModelSelection({ modelKey: "zai-org/GLM-5.3-Flash", strength })).toBe(true);
    expect(validModelSelection({ modelKey: "zai-org/GLM-5.3-Flash", strength: "off" })).toBe(false);
    for (const strength of ["default", "off", "high"] as const)
      expect(validModelSelection({ modelKey: "tencent/Hy4-preview", strength })).toBe(true);
    for (const strength of ["low", "max"] as const)
      expect(validModelSelection({ modelKey: "tencent/Hy4-preview", strength })).toBe(false);
  });
  it("publishes provider limits and preserves automatic or manual restored selections", () => {
    expect(modelOutputLimit()).toBe(393216);
    expect(modelOutputLimit("zai-org/GLM-5.3")).toBe(262144);
    expect(modelOutputLimit("tencent/Hy4-preview")).toBe(262144);
    expect(initialModelSelection()).toEqual({ modelKey: "deepseek-direct", strength: "off" });
    expect(initialModelSelection({ maxOutputTokens: 300000, strength: "low" })).toMatchObject({
      maxOutputTokens: 300000,
      strength: "low",
    });
    for (const maxOutputTokens of [1, 128, 8193, 393216])
      expect(validModelSelection({ maxOutputTokens })).toBe(true);
    for (const maxOutputTokens of [0, 1.5, 393217])
      expect(validModelSelection({ maxOutputTokens })).toBe(false);
    expect(validModelSelection({ modelKey: "zai-org/GLM-5.3", maxOutputTokens: 131072 })).toBe(
      true,
    );
    expect(validModelSelection({ modelKey: "zai-org/GLM-5.3", maxOutputTokens: 262145 })).toBe(
      false,
    );
  });
  it("uses auto as the provider ceiling without treating it as a required daily quota", () => {
    const env = {
      ...liveEnv(),
      PROMPTMASTER_MODEL_MAX_OUTPUT_TOKENS: "auto",
      PROMPTMASTER_MODEL_DAILY_TOKEN_LIMIT: "1000",
    };
    expect(readModelOutputCeiling(env)).toBe(393216);
    expect(readModelOutputCeiling(env, "zai-org/GLM-5.3")).toBe(262144);
    expect(readModelConfig(env)).toMatchObject({
      maxOutputTokens: 393216,
      reasoningTokenReserve: 0,
    });
    expect(readModelConfig(env, { maxOutputTokens: 393216 })).toMatchObject({
      maxOutputTokens: 393216,
    });
    expect(readModelOutputCeiling({ ...env, PROMPTMASTER_MODEL_MAX_OUTPUT_TOKENS: "1200" })).toBe(
      393216,
    );
    expect(readModelConfig(env, { maxOutputTokens: 1201 })).toMatchObject({
      maxOutputTokens: 393216,
    });
  });
  it("defaults to the complete model ceiling even when old clients provide lower limits", () => {
    const env = { ...liveEnv(), PROMPTMASTER_MODEL_MAX_OUTPUT_TOKENS: "auto" };
    expect(
      readModelConfig(env, {}, { kind: "PLAYGROUND", goal: "Build a complete HTML dashboard" }),
    ).toMatchObject({ maxOutputTokens: 393216, timeoutMs: 120000 });
    for (const [strength, budget] of [
      ["low", 393216],
      ["high", 393216],
      ["max", 393216],
    ] as const) {
      expect(readModelConfig(env, { strength })).toMatchObject({
        strength,
        maxOutputTokens: budget,
        timeoutMs: 300000,
        reasoningTokenReserve: 0,
      });
    }
    expect(readModelConfig(env, { strength: "max", maxOutputTokens: 100 })).toMatchObject({
      maxOutputTokens: 393216,
    });
    expect(
      readModelConfig(
        { ...env, PROMPTMASTER_DEEPSEEK_THINKING_TIMEOUT_MS: "450000" },
        { strength: "low" },
      ),
    ).toMatchObject({ timeoutMs: 450000 });
    expect(() =>
      readModelConfig(
        { ...env, PROMPTMASTER_DEEPSEEK_THINKING_TIMEOUT_MS: "600001" },
        { strength: "low" },
      ),
    ).toThrow("THINKING_TIMEOUT_MS");
  });
  it("keeps a larger direct environment ceiling compatible with other provider limits", () => {
    const env = { ...liveEnv(), PROMPTMASTER_MODEL_MAX_OUTPUT_TOKENS: "100000" };
    expect(readModelOutputCeiling(env)).toBe(393216);
    expect(readModelOutputCeiling(env, "zai-org/GLM-5.3")).toBe(262144);
  });
  it("uses local noncommercial guardrails and validates monetary/window settings", () => {
    expect(readQuotaDefaults({})).toEqual({
      dailyTokenLimit: 4500000,
      dailyCostLimitUsd: 6,
      pricingWindow: "AUTO",
    });
    expect(() => readQuotaDefaults({ PROMPTMASTER_MODEL_DAILY_COST_LIMIT_USD: "-1" })).toThrow();
    expect(() => readQuotaDefaults({ PROMPTMASTER_MODEL_DAILY_COST_LIMIT_USD: "NaN" })).toThrow();
    expect(() => readQuotaDefaults({ PROMPTMASTER_MODEL_PRICING_WINDOW: "guess" })).toThrow();
    expect(
      readQuotaDefaults({ PROMPTMASTER_MODEL_DAILY_COST_LIMIT_USD: "0" }).dailyCostLimitUsd,
    ).toBe(0);
  });
  it("is disabled by default", () => {
    expect(readModelConfig({})).toEqual({ mode: "DISABLED" });
  });

  it("loads the DeepSeek live configuration without exposing its key publicly", () => {
    const config = readModelConfig(liveEnv());
    expect(config.mode).toBe("LIVE");
    const publicConfig = publicModelConfig(config);
    expect(publicConfig).toMatchObject({
      mode: "LIVE",
      configured: true,
      provider: "deepseek",
      model: "deepseek-flash",
      productVersion: "DeepSeek-V4.1-Flash-1017",
      dailyCostLimitUsd: 5,
      pricingWindow: "AUTO",
    });
    expect(JSON.stringify(publicConfig)).not.toContain("test-secret-value");
    expect(JSON.stringify(publicConfig)).not.toContain("apiKey");
  });

  it("rejects incomplete or insecure live configuration", () => {
    const missing = liveEnv();
    delete missing.DEEPSEEK_API_KEY;
    expect(() => readModelConfig(missing)).toThrow(ModelServiceError);

    const insecure = liveEnv();
    insecure.DEEPSEEK_BASE_URL = "http://api.deepseek.com";
    expect(() => readModelConfig(insecure)).toThrow("must use HTTPS");
  });

  it("does not apply the SiliconFlow deadline to the direct provider", () => {
    expect(readModelConfig({ ...liveEnv(), SILICONFLOW_MODEL_TIMEOUT_MS: "300000" })).toMatchObject(
      {
        provider: "deepseek",
        timeoutMs: 120000,
      },
    );
    expect(() =>
      readModelConfig({ ...liveEnv(), PROMPTMASTER_MODEL_TIMEOUT_MS: "120001" }),
    ).toThrow("PROMPTMASTER_MODEL_TIMEOUT_MS");
  });
});
