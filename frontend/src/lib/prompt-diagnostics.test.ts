import { describe, expect, it } from "vitest";
import { initialModelSelection, validModelSelection } from "./model-catalog";
import {
  adviceHistoryForVersion,
  adviceMatchesSelection,
  diagnosePrompt,
} from "./prompt-diagnostics";
import type { LiveAdvice } from "./types";

const advice: LiveAdvice = {
  id: "adv_test",
  executionId: "mex_test",
  promptId: "p",
  versionId: "v",
  provider: "deepseek",
  model: "deepseek-flash",
  productVersion: "DeepSeek-V4.1-Flash-1017",
  strength: "off",
  content: "Synthetic advice",
  createdAt: "2026-11-06T00:00:00Z",
  usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
};
describe("saved prompt diagnostics and model attribution", () => {
  it("defaults new generation to direct DeepSeek and normalizes incomplete restored selections", () => {
    expect(initialModelSelection()).toEqual({
      modelKey: "deepseek-direct",
      strength: "off",
    });
    for (const key of ["zai-org/GLM-5.3-Flash", "tencent/Hy4-preview", "zai-org/GLM-5.3"]) {
      const selected = initialModelSelection({ modelKey: key, maxOutputTokens: 512 });
      expect(selected.strength).toBe("default");
      expect(validModelSelection(selected)).toBe(true);
    }
    expect(
      initialModelSelection({ modelKey: "deepseek-ai/DeepSeek-V4-Pro", strength: "max" }).strength,
    ).toBe("max");
    expect(initialModelSelection({ modelKey: "unknown" }).modelKey).toBe("deepseek-direct");
  });
  it.each(["en", "zh-CN"] as const)(
    "uses exact source excerpts without changing the source (%s)",
    (locale) => {
      const source =
        "😀 Act as a specialist.\nGoal: create a plan.\nContext: assumed input.\nMust avoid secrets.\nOutput format: Markdown.\nAcceptance: test and verify.";
      const diagnostics = diagnosePrompt(source, locale);
      expect(diagnostics).toHaveLength(6);
      for (const check of diagnostics) {
        expect(check.status).toBe("MARKER_FOUND");
        expect(source.slice(check.evidence!.start, check.evidence!.end)).toBe(
          check.evidence!.quote,
        );
        expect(check).not.toHaveProperty("score");
        expect(check).not.toHaveProperty("grade");
      }
      expect(
        diagnosePrompt(
          "作为助手。目标：计划。背景：输入。要求：不得泄密。输出格式：表格。验收：验证。",
          locale,
        ).every((d) => !!d.evidence),
      ).toBe(true);
    },
  );
  it("never turns empty or unfamiliar text into a failing score", () => {
    for (const text of ["", "🌍", "lorem ipsum"]) {
      expect(
        diagnosePrompt(text, "en").every((d) => d.status === "NOT_DETECTED" && d.evidence === null),
      ).toBe(true);
    }
  });
  it("does not treat negated markers as proof of semantic quality", () => {
    expect(
      diagnosePrompt("No output format is specified; no evidence exists.", "en").find(
        (d) => d.id === "format",
      )?.status,
    ).toBe("MARKER_FOUND");
  });
  it("matches actual provider/model/strength rather than the current UI label", () => {
    expect(adviceMatchesSelection(advice, initialModelSelection())).toBe(true);
    const sf = {
      ...advice,
      provider: "siliconflow" as const,
      model: "zai-org/GLM-5.3",
      productVersion: "zai-org/GLM-5.3",
      strength: "default" as const,
    };
    expect(adviceMatchesSelection(sf, initialModelSelection())).toBe(false);
    expect(adviceMatchesSelection(sf, { modelKey: "zai-org/GLM-5.3" })).toBe(true);
    expect(
      adviceMatchesSelection({ ...advice, strength: undefined }, initialModelSelection()),
    ).toBe(false);
    expect(
      adviceMatchesSelection({ ...sf, strength: "max" }, { modelKey: "zai-org/GLM-5.3" }),
    ).toBe(false);
    expect(adviceMatchesSelection(advice, { modelKey: "unknown" })).toBe(false);
  });
  it("sorts only exact-version history without mutating persisted records", () => {
    const input = [
      advice,
      { ...advice, executionId: "new", createdAt: "2026-11-06T01:00:00Z" },
      { ...advice, versionId: "other" },
      { ...advice, promptId: "other" },
    ];
    const before = structuredClone(input);
    expect(adviceHistoryForVersion(input, "p", "v").map((a) => a.executionId)).toEqual([
      "new",
      "mex_test",
    ]);
    expect(input).toEqual(before);
  });
});
