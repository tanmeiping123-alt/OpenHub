import { describe, expect, it } from "vitest";
import { executionEvidenceFor, localizeFixtureOutput } from "./execution-evidence";
import type { AppState } from "./types";
const live: AppState["playgroundRuns"][number] = {
  id: "session",
  versionId: "v1",
  executionId: "mex",
  source: "DEEPSEEK_LIVE_PLAYGROUND",
  outputs: [{ name: "DeepSeek", text: "真实输出", source: "DEEPSEEK_LIVE_PLAYGROUND" }],
};
describe("Layer 3 execution evidence gate", () => {
  it("accepts SiliconFlow only with matching output source and precise version", () => {
    const sf = {
      ...live,
      source: "SILICONFLOW_LIVE_PLAYGROUND",
      outputs: [{ name: "GLM", text: "real output", source: "SILICONFLOW_LIVE_PLAYGROUND" }],
    };
    expect(executionEvidenceFor([sf], "v1").status).toBe("EXECUTED_UNGRADED");
    expect(executionEvidenceFor([sf], "other").status).toBe("NOT_EXECUTED");
    expect(executionEvidenceFor([{ ...sf, outputs: live.outputs }], "v1").status).toBe(
      "NOT_EXECUTED",
    );
  });
  it("recognizes exact-version real evidence without a numeric score", () => {
    expect(executionEvidenceFor([live], "v1")).toMatchObject({
      status: "EXECUTED_UNGRADED",
      score: null,
      grade: null,
      run: live,
    });
    expect(executionEvidenceFor([live], "v2").status).toBe("NOT_EXECUTED");
  });
  it("rejects a model name, mock text, empty output or missing execution binding", () => {
    for (const run of [
      { ...live, source: "MOCK_SIMULATED" },
      { ...live, executionId: undefined },
      { ...live, outputs: [{ name: "DeepSeek", text: "text" }] },
      { ...live, outputs: [{ ...live.outputs[0], text: " " }] },
    ]) {
      expect(executionEvidenceFor([run], "v1").status).toBe("NOT_EXECUTED");
    }
  });
  it("does not erase earlier live evidence when a later mock run exists", () => {
    expect(executionEvidenceFor([{ ...live, source: "MOCK_SIMULATED" }, live], "v1").run).toBe(
      live,
    );
  });
  it("never replaces real Chinese output with fixture translations", () => {
    expect(localizeFixtureOutput("DeepSeek", "真实输出", "zh-CN")).toBe("真实输出");
    expect(localizeFixtureOutput("Demo Model A", "fixture", "en")).toBe("fixture");
    expect(localizeFixtureOutput("Demo Model A", "fixture", "zh-CN")).toContain("本地预置");
  });
});
