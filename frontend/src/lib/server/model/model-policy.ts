import "server-only";
import { createHash } from "node:crypto";
import { deepSeekPrompts } from "./deepseek-provider";
import type { LiveModelConfig, ModelGenerateInput, ModelMessage } from "./model-types";

export const MODEL_POLICY_VERSION = "core-first-full-output-v2";
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

// A frozen request is both the quota estimate input and the exact supplier message payload.
export function prepareModelDispatch(input: ModelGenerateInput, config: LiveModelConfig) {
  const prompt = deepSeekPrompts(input);
  const messages: readonly ModelMessage[] = Object.freeze([
    Object.freeze({ role: "system" as const, content: prompt.system }),
    Object.freeze({ role: "user" as const, content: prompt.user }),
  ]);
  const serializedMessages = JSON.stringify(messages);
  const messagesSha256 = sha256(serializedMessages);
  return {
    policyVersion: MODEL_POLICY_VERSION,
    messages,
    serializedMessages,
    messagesSha256,
    inputSha256: sha256(
      JSON.stringify({
        policyVersion: MODEL_POLICY_VERSION,
        messages,
        provider: config.provider,
        model: config.model,
        productVersion: config.productVersion,
        strength: config.strength,
        maxOutputTokens: config.maxOutputTokens,
        reasoningTokenReserve: config.reasoningTokenReserve ?? 0,
      }),
    ),
  };
}
