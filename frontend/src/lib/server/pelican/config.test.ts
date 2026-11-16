import { describe, expect, it } from "vitest";
import { readModelConfig } from "../model/model-config";
import { readPelicanModelConfig, pelicanModelOutputCeiling } from "./config";

const env = {
  PROMPTMASTER_MODEL_MODE: "live",
  PROMPTMASTER_MODEL_PROVIDER: "deepseek",
  DEEPSEEK_API_KEY: "synthetic-unused",
  DEEPSEEK_BASE_URL: "https://api.deepseek.com",
  DEEPSEEK_MODEL: "deepseek-flash",
  DEEPSEEK_PRODUCT_VERSION: "DeepSeek-V4.1-Flash-1017",
  SILICONFLOW_API_KEY: "synthetic-unused",
  PROMPTMASTER_MODEL_MAX_OUTPUT_TOKENS: "1200",
  PROMPTMASTER_MODEL_TIMEOUT_MS: "30000",
  PROMPTMASTER_PELICAN_MAX_OUTPUT_TOKENS: "8192",
  PROMPTMASTER_PELICAN_TIMEOUT_MS: "120000",
};

describe("Pelican scoped execution settings", () => {
  it("uses no generation deadline for new artwork snapshots", () => {
    expect(readPelicanModelConfig({ ...env, PROMPTMASTER_PELICAN_TIMEOUT_MS: "0" })).toMatchObject({
      timeoutMs: 0,
    });
    expect(readModelConfig(env)).toMatchObject({ timeoutMs: 120000 });
  });
  it("defaults automatic art budgets to the provider capability and includes selected thinking", () => {
    const automatic = { ...env, PROMPTMASTER_PELICAN_MAX_OUTPUT_TOKENS: "auto" };
    expect(pelicanModelOutputCeiling(automatic)).toBe(393216);
    expect(readPelicanModelConfig(automatic)).toMatchObject({
      maxOutputTokens: 393216,
      maxRetries: 0,
    });
    expect(readPelicanModelConfig(automatic, { strength: "low" })).toMatchObject({
      strength: "low",
      reasoningTokenReserve: 0,
      maxOutputTokens: 393216,
      timeoutMs: 0,
    });
    expect(readPelicanModelConfig(automatic, { maxOutputTokens: 65536 })).toMatchObject({
      maxOutputTokens: 393216,
    });
  });
  it("permits a complete artwork budget without changing shared settings or quotas", () => {
    expect(readPelicanModelConfig(env, { maxOutputTokens: 8192 })).toMatchObject({
      maxOutputTokens: 393216,
      timeoutMs: 0,
      maxRetries: 0,
      dailyCostLimitUsd: 6,
    });
    expect(readModelConfig(env)).toMatchObject({ maxOutputTokens: 393216, timeoutMs: 120000 });
    expect(env.PROMPTMASTER_MODEL_MAX_OUTPUT_TOKENS).toBe("1200");
  });
  it("inherits existing settings when scoped settings are absent", () => {
    const base: Record<string, string | undefined> = { ...env };
    delete base.PROMPTMASTER_PELICAN_MAX_OUTPUT_TOKENS;
    delete base.PROMPTMASTER_PELICAN_TIMEOUT_MS;
    expect(readPelicanModelConfig(base)).toMatchObject({
      maxOutputTokens: 393216,
      timeoutMs: 0,
      maxRetries: 0,
    });
  });
  it("allows the documented SiliconFlow answer ceiling without raising reasoning reserves", () => {
    const automatic = { ...env, PROMPTMASTER_PELICAN_MAX_OUTPUT_TOKENS: "auto" };
    expect(pelicanModelOutputCeiling(automatic, "zai-org/GLM-5.3")).toBe(262144);
    expect(
      readPelicanModelConfig(automatic, {
        modelKey: "zai-org/GLM-5.3",
        strength: "max",
      }),
    ).toMatchObject({ maxOutputTokens: 262144, reasoningTokenReserve: 32768, timeoutMs: 0 });
    expect(
      readPelicanModelConfig(automatic, {
        modelKey: "zai-org/GLM-5.3",
        maxOutputTokens: 262144,
      }),
    ).toMatchObject({ maxOutputTokens: 262144 });
    expect(() =>
      readPelicanModelConfig(automatic, {
        modelKey: "zai-org/GLM-5.3",
        maxOutputTokens: 262145,
      }),
    ).toThrow();
  });
  it("keeps the independent SiliconFlow timeout", () => {
    expect(
      readPelicanModelConfig(env, { modelKey: "deepseek-ai/DeepSeek-V4-Pro", strength: "off" }),
    ).toMatchObject({ maxOutputTokens: 393216, timeoutMs: 0 });
  });
  it("ignores retired output env settings and rejects out-of-model selections", () => {
    expect(
      readPelicanModelConfig({ ...env, PROMPTMASTER_PELICAN_MAX_OUTPUT_TOKENS: "393217" }),
    ).toMatchObject({ maxOutputTokens: 393216 });
    expect(() => readPelicanModelConfig(env, { maxOutputTokens: 393217 })).toThrow();
  });
});
