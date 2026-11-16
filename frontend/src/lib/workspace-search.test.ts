import { describe, expect, it } from "vitest";
import {
  buildSearchDocuments,
  fuzzyScore,
  normalizeSearch,
  searchDocuments,
  searchSnippet,
} from "./workspace-search";
import { createInitialState } from "./fixtures";

describe("workspace fuzzy search", () => {
  it("finds saved purposes and tags when the historical task type is General", () => {
    const state = createInitialState();
    const prompt = {
      ...state.prompts[0],
      id: "metadata-only",
      taskType: "General" as const,
      descriptor: { purposes: ["analyze" as const], tags: ["经营复盘"] },
    };
    const version = {
      ...state.versions[0],
      promptId: prompt.id,
      id: prompt.currentVersionId,
      title: "Unique",
      content: "Unique content",
    };
    const documents = buildSearchDocuments({ prompts: [prompt], versions: [version] }, "zh-CN");
    expect(searchDocuments(documents, "分析与研究 经营复盘").total).toBe(1);
    expect(searchDocuments(documents, "Analyze research").total).toBe(1);
    expect(searchDocuments(documents, "General").total).toBe(0);
  });
  it("normalizes full-width text, case, punctuation and whitespace", () => {
    expect(normalizeSearch("  ＰＲＯＭＰＴ：恢复\n任务 ")).toBe("prompt 恢复 任务");
    expect(fuzzyScore("ＰＹＴＨＯＮ", ["Python implementation"])).not.toBeNull();
  });
  it("supports Chinese substrings and unordered AND keywords across fields", () => {
    expect(fuzzyScore("恢复 软删除", ["任务软删除", "恢复机制"])).not.toBeNull();
    expect(fuzzyScore("恢复 发票", ["软删除与恢复"])).toBeNull();
    expect(fuzzyScore("恢", ["恢复"])).not.toBeNull();
  });
  it.each(["promt", "prommpt", "prampt", "promtp"])(
    "tolerates one Latin word edit: %s",
    (query) => {
      expect(fuzzyScore(query, ["Prompt planning"])).not.toBeNull();
    },
  );
  it("does not fuzzy-match short words, Chinese typos or two edits", () => {
    expect(fuzzyScore("cat", ["cut"])).toBeNull();
    expect(fuzzyScore("恢复", ["灰复"])).toBeNull();
    expect(fuzzyScore("prammt", ["prompt"])).toBeNull();
    expect(fuzzyScore("xyzq", ["unrelated"])).toBeNull();
  });
  it("ranks title matches above body and typo matches", () => {
    expect(fuzzyScore("prompt", ["Prompt", ""])).toBeGreaterThan(
      fuzzyScore("prompt", ["Other", "Prompt"])!,
    );
    expect(fuzzyScore("prompt", ["Prompt"])).toBeGreaterThan(fuzzyScore("promt", ["Prompt"])!);
  });
  it("only indexes supplied authorized prompts, ignoring orphan versions", () => {
    const initial = createInitialState();
    const prompt = initial.prompts[0];
    const documents = buildSearchDocuments(
      { prompts: [prompt], versions: initial.versions },
      "zh-CN",
    );
    expect(documents.length).toBeGreaterThan(0);
    expect(documents.every((d) => d.prompt.id === prompt.id)).toBe(true);
    expect(searchDocuments(documents, "学习计划").total).toBe(0);
  });
  it("includes localized display text and task types", () => {
    const documents = buildSearchDocuments(createInitialState(), "zh-CN");
    expect(searchDocuments(documents, "编程").total).toBeGreaterThan(0);
    expect(searchDocuments(documents, "学习计划").total).toBeGreaterThan(0);
    expect(searchDocuments(documents, "python").total).toBeGreaterThan(0);
  });
  it("shows only current versions when blank, bounds results, and finds historical content", () => {
    const documents = buildSearchDocuments(createInitialState(), "en");
    expect(searchDocuments(documents, "").items.every((item) => item.current)).toBe(true);
    expect(searchDocuments(documents, "", 2).items).toHaveLength(2);
    expect(searchDocuments(documents, "", 0).items).toEqual([]);
    const historic = documents.find((d) => !d.current)!;
    const custom = [{ ...historic, fields: ["uniquehistword"] }];
    expect(searchDocuments(custom, "uniquehistword").items[0].version.id).toBe(historic.version.id);
  });
  it("caps query length and emits bounded, readable text snippets", () => {
    expect(fuzzyScore("a".repeat(120) + " nevermatch", ["a".repeat(120)])).not.toBeNull();
    const snippet = searchSnippet("a".repeat(200) + "恢复任务\n计划" + "z".repeat(200), "恢复");
    expect(snippet).toContain("恢复任务 计划");
    expect(snippet.length).toBeLessThanOrEqual(142);
    expect(snippet.startsWith("…")).toBe(true);
  });
});
