import type { LiveModelConfig } from "./model-types";

type RequestConfig = Pick<
  LiveModelConfig,
  "provider" | "strength" | "maxOutputTokens" | "reasoningTokenReserve"
> &
  Partial<Pick<LiveModelConfig, "model">>;

export function modelRequestOptions(config: RequestConfig) {
  const common = { max_tokens: config.maxOutputTokens };
  if (config.provider === "deepseek") {
    if (config.strength === "low" || config.strength === "high" || config.strength === "max")
      return { ...common, thinking: { type: "enabled" }, reasoning_effort: config.strength };
    // Saved Pelican requests depend on omitting reasoning_effort when off.
    return { ...common, thinking: { type: "disabled" } };
  }
  // GLM-5.3 / GLM-5.3-Flash have always-on reasoning; their native API accepts
  // effort alone. https://siliconflow.com/models/glm-5-3-flash
  if (config.model === "zai-org/GLM-5.3" || config.model === "zai-org/GLM-5.3-Flash")
    return config.strength === "low" || config.strength === "high" || config.strength === "max"
      ? { ...common, reasoning_effort: config.strength }
      : common;
  // Hy4-preview uses no_think / high in its provider schema; do not send the generic
  // enable_thinking/thinking_budget pair. https://siliconflow.com/models/hy4-preview
  if (config.model === "tencent/Hy4-preview") {
    if (config.strength === "off") return { ...common, reasoning_effort: "no_think" };
    if (config.strength === "high") return { ...common, reasoning_effort: "high" };
    return common;
  }
  if (config.strength === "off") return { ...common, enable_thinking: false };
  if (config.strength === "high" || config.strength === "max")
    return {
      ...common,
      enable_thinking: true,
      reasoning_effort: config.strength,
      thinking_budget: config.reasoningTokenReserve ?? 32768,
    };
  return common;
}
