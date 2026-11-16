import { describe, expect, it } from "vitest";
import { PELICAN_PROMPT } from "@/lib/pelican-types";
import { pelicanMessages, pelicanPayload, parsePelicanCreate } from "./policy";
import { readModelConfig } from "../model/model-config";

describe("fixed pelican dispatch policy", () => {
  it("contains one uniform delivery instruction plus the unchanged user challenge", () => {
    expect(pelicanMessages()).toEqual([
      { role: "system", content: expect.stringContaining("只返回一份") },
      { role: "user", content: PELICAN_PROMPT },
    ]);
    expect(PELICAN_PROMPT).toBe("创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画");
  });
  it("snapshots the actual vendor-specific limits, default reasoning and temperature", () => {
    const config = readModelConfig(
      { PROMPTMASTER_MODEL_MODE: "live", SILICONFLOW_API_KEY: "synthetic" },
      { modelKey: "zai-org/GLM-5.3", maxOutputTokens: 1024 },
    );
    if (config.mode !== "LIVE") throw Error("EXPECTED_LIVE");
    expect(pelicanPayload(config)).toEqual({
      model: "zai-org/GLM-5.3",
      messages: pelicanMessages(),
      max_tokens: 262144,
      temperature: 0.2,
      stream: false,
    });
    expect(config.reasoningTokenReserve).toBe(32768);
  });
  it("rejects arbitrary messages, duplicate models and injected provider parameters", () => {
    const valid = {
      requestKey: "request_123",
      title: "First batch",
      selections: [{ modelKey: "deepseek-direct", strength: "off", maxOutputTokens: 1024 }],
    };
    expect(parsePelicanCreate(valid)).toEqual(valid);
    for (const invalid of [
      { ...valid, prompt: "different" },
      { ...valid, selections: [...valid.selections, ...valid.selections] },
      { ...valid, selections: [{ modelKey: "deepseek-direct", apiKey: "forbidden" }] },
    ])
      expect(() => parsePelicanCreate(invalid)).toThrow();
  });
});
