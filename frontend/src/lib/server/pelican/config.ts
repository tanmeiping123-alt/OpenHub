import "server-only";
import type { ModelSelection } from "@/lib/model-catalog";
import { readModelConfig, readModelOutputCeiling } from "../model/model-config";
import { PELICAN_PROMPT } from "@/lib/pelican-types";

// New artwork calls share the model maximum; frozen historical samples replay separately.
export function readPelicanModelConfig(
  env: Record<string, string | undefined> = process.env,
  selection: ModelSelection = {},
) {
  const config = readModelConfig(env, selection, { kind: "PLAYGROUND", goal: PELICAN_PROMPT });
  return config.mode === "LIVE" ? { ...config, timeoutMs: 0, maxRetries: 0 } : config;
}

export function pelicanModelOutputCeiling(
  env: Record<string, string | undefined> = process.env,
  modelKey?: string,
) {
  return readModelOutputCeiling(env, modelKey);
}
