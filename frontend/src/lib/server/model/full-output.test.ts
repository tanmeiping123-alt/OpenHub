import { describe, expect, it } from "vitest";
import { MODEL_CATALOG, modelOutputLimit } from "@/lib/model-catalog";
import { readModelConfig, readModelOutputCeiling } from "./model-config";
import { readPelicanModelConfig } from "../pelican/config";
const env = {
  PROMPTMASTER_MODEL_MODE: "live",
  PROMPTMASTER_MODEL_PROVIDER: "deepseek",
  DEEPSEEK_API_KEY: "synthetic-unused",
  DEEPSEEK_BASE_URL: "https://api.deepseek.com",
  DEEPSEEK_MODEL: "deepseek-flash",
  DEEPSEEK_PRODUCT_VERSION: "DeepSeek-V4.1-Flash-1017",
  SILICONFLOW_API_KEY: "synthetic-unused",
  PROMPTMASTER_MODEL_MAX_OUTPUT_TOKENS: "1200",
  PROMPTMASTER_PELICAN_MAX_OUTPUT_TOKENS: "8192",
  PROMPTMASTER_MODEL_DAILY_TOKEN_LIMIT: "1000",
};
describe("full model output for all new requests", () => {
  it.each(MODEL_CATALOG)(
    "uses $key maximum in every workflow despite legacy lower settings",
    (model) => {
      const limit = modelOutputLimit(model.key);
      expect(readModelOutputCeiling(env, model.key)).toBe(limit);
      for (const kind of [
        "PROMPT_GENERATION",
        "OPTIMIZATION",
        "PLAYGROUND",
        "EVALUATION_ADVICE",
        "EVALUATION_REPORT",
      ]) {
        for (const strength of model.strengths) {
          expect(
            readModelConfig(env, { modelKey: model.key, strength, maxOutputTokens: 128 }, { kind }),
          ).toMatchObject({
            maxOutputTokens: limit,
            dailyTokenLimit: 1000,
            strength,
          });
        }
      }
      expect(
        readPelicanModelConfig(env, { modelKey: model.key, maxOutputTokens: 128 }),
      ).toMatchObject({
        maxOutputTokens: limit,
        timeoutMs: 0,
        dailyTokenLimit: 1000,
      });
    },
  );
});
