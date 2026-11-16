import { describe, expect, it } from "vitest";
import {
  canonicalSearch,
  legacyPurposes,
  normalizeTags,
  parsePromptDescriptor,
  purposes,
  suggestPromptDescriptor,
  descriptorForPrompt,
  promptPurposeLabel,
} from "./prompt-description";

describe("independent prompt descriptions", () => {
  it("prefers current purposes over legacy types and respects an explicitly cleared classification", () => {
    const prompt = {
      taskType: "Writing" as const,
      descriptor: { purposes: ["analyze" as const, "plan" as const], tags: ["经营"] },
    };
    expect(descriptorForPrompt(prompt)).toEqual(prompt.descriptor);
    expect(promptPurposeLabel(prompt, "zh-CN")).toBe("分析与研究、规划与决策");
    expect(descriptorForPrompt({ taskType: "Writing" })).toEqual({
      purposes: ["create"],
      tags: [],
    });
    expect(promptPurposeLabel({ ...prompt, descriptor: { purposes: [], tags: [] } }, "zh-CN")).toBe(
      "未分类",
    );
  });
  it("uses the same canonical vocabulary for query and public text", () => {
    expect(canonicalSearch("简历修改 面试")).toBe(canonicalSearch("简历优化 面试"));
    expect(canonicalSearch("RESUME EDITING  Interview")).toBe(
      canonicalSearch("resume optimization interview"),
    );
    expect(canonicalSearch("coffee launch")).not.toContain("resume");
    expect(canonicalSearch("ＲＥＳＵＭＥ  EDITING")).toBe("resume optimization");
    expect(canonicalSearch("résumé editing")).toBe("resume optimization");
  });
  it("provides six bilingual overlapping purposes and conservative legacy mappings", () => {
    expect(purposes).toHaveLength(6);
    expect(purposes.every((p) => p.name.en && p.name["zh-CN"])).toBe(true);
    expect(legacyPurposes("General")).toEqual([]);
    expect(legacyPurposes("Writing")).toEqual(["create"]);
    expect(legacyPurposes("AI Agent")).toEqual(["build"]);
  });
  it("suggests multiple purposes without inventing unknown classifications", () => {
    const result = suggestPromptDescriptor(
      "分析销售数据，找出下滑原因，再写一段给老板看的汇报",
      "zh-CN",
    );
    expect(result.purposes).toEqual(expect.arrayContaining(["analyze", "create"]));
    expect(result.tags).toContain("汇报");
    expect(suggestPromptDescriptor("xyz", "en")).toEqual({ purposes: [], tags: [] });
    expect(
      suggestPromptDescriptor("Translate the paragraph and improve my resume", "en").purposes,
    ).toEqual(expect.arrayContaining(["understand", "improve"]));
  });
  it("merges common tag synonyms and case while preserving understandable labels", () => {
    expect(
      normalizeTags([" 写文案 ", "文案写作", "AI Agent", "ai agent", "简历修改", "简历优化"]),
    ).toEqual(["文案写作", "AI Agent", "简历优化"]);
  });
  it("preserves an explicitly empty descriptor and rejects malformed or abusive metadata", () => {
    expect(parsePromptDescriptor({ purposes: [], tags: [] })).toEqual({ purposes: [], tags: [] });
    expect(
      parsePromptDescriptor({ purposes: ["build", "build"], tags: ["test"] }).purposes,
    ).toEqual(["build"]);
    for (const value of [
      null,
      { purposes: ["unknown"], tags: [] },
      { purposes: [], tags: Array(13).fill("x") },
      { purposes: [], tags: ["x".repeat(41)] },
      { purposes: [], tags: ["<script>spam</script>"] },
      { purposes: [], tags: ["https://spam.test"] },
      { purposes: [], tags: ["a\nspam"] },
      { purposes: [], tags: [], content: "private" },
    ])
      expect(() => parsePromptDescriptor(value)).toThrow("INVALID_DESCRIPTOR");
  });
});
