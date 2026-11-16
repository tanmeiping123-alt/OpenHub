import { describe, expect, it } from "vitest";
import { modelRequestOptions } from "./model-request-options";

describe("provider request options", () => {
  it("keeps the direct nonthinking payload compatible with saved requests", () => {
    expect(
      modelRequestOptions({ provider: "deepseek", maxOutputTokens: 393216, strength: "off" }),
    ).toEqual({ max_tokens: 393216, thinking: { type: "disabled" } });
  });
  it.each(["low", "high", "max"] as const)(
    "maps direct %s reasoning within max_tokens",
    (strength) => {
      expect(
        modelRequestOptions({
          provider: "deepseek",
          maxOutputTokens: 32768,
          strength,
          reasoningTokenReserve: 0,
        }),
      ).toEqual({ max_tokens: 32768, thinking: { type: "enabled" }, reasoning_effort: strength });
    },
  );
  it("retains SiliconFlow additive reasoning budget fields", () => {
    expect(
      modelRequestOptions({
        provider: "siliconflow",
        maxOutputTokens: 4096,
        strength: "high",
        reasoningTokenReserve: 32768,
      }),
    ).toEqual({
      max_tokens: 4096,
      enable_thinking: true,
      reasoning_effort: "high",
      thinking_budget: 32768,
    });
    expect(
      modelRequestOptions({ provider: "siliconflow", maxOutputTokens: 4096, strength: "default" }),
    ).toEqual({ max_tokens: 4096 });
    expect(
      modelRequestOptions({ provider: "siliconflow", maxOutputTokens: 4096, strength: "off" }),
    ).toEqual({ max_tokens: 4096, enable_thinking: false });
  });
  it.each(["low", "high", "max"] as const)(
    "maps GLM-5.3 %s using its native effort parameter only",
    (strength) => {
      expect(
        modelRequestOptions({
          provider: "siliconflow",
          model: "zai-org/GLM-5.3",
          maxOutputTokens: 4096,
          strength,
          reasoningTokenReserve: 32768,
        }),
      ).toEqual({ max_tokens: 4096, reasoning_effort: strength });
    },
  );
  it.each(["low", "high", "max"] as const)(
    "maps GLM-5.3-Flash %s using its native effort parameter only",
    (strength) => {
      expect(
        modelRequestOptions({
          provider: "siliconflow",
          model: "zai-org/GLM-5.3-Flash",
          maxOutputTokens: 4096,
          strength,
          reasoningTokenReserve: 32768,
        }),
      ).toEqual({ max_tokens: 4096, reasoning_effort: strength });
    },
  );
  it("maps Hy4-preview no_think / high without generic thinking controls", () => {
    expect(
      modelRequestOptions({
        provider: "siliconflow",
        model: "tencent/Hy4-preview",
        maxOutputTokens: 4096,
        strength: "off",
      }),
    ).toEqual({ max_tokens: 4096, reasoning_effort: "no_think" });
    expect(
      modelRequestOptions({
        provider: "siliconflow",
        model: "tencent/Hy4-preview",
        maxOutputTokens: 4096,
        strength: "high",
      }),
    ).toEqual({ max_tokens: 4096, reasoning_effort: "high" });
    expect(
      modelRequestOptions({
        provider: "siliconflow",
        model: "tencent/Hy4-preview",
        maxOutputTokens: 4096,
        strength: "default",
      }),
    ).toEqual({ max_tokens: 4096 });
  });
  it("preserves the frozen GLM default request without reasoning overrides", () => {
    expect(
      modelRequestOptions({
        provider: "siliconflow",
        model: "zai-org/GLM-5.3",
        maxOutputTokens: 2048,
        strength: "default",
      }),
    ).toEqual({ max_tokens: 2048 });
  });
});
