import { describe, expect, it } from "vitest";
import { hasUnsavedDraft, promptActionHref, resolvePromptContext } from "./prompt-navigation";
import { createInitialState } from "./fixtures";

describe("exact Prompt navigation", () => {
  const state = createInitialState();
  const version = state.versions[0];
  it("carries the same saved version through editing, evaluation, running and sharing", () => {
    for (const action of ["edit", "evaluate", "optimize", "playground", "share"] as const) {
      const href = promptActionHref("zh-CN", version.promptId, version.id, action);
      expect(href).toContain(encodeURIComponent(version.id));
    }
  });
  it("never falls back to a different object for an invalid explicit route", () => {
    expect(resolvePromptContext(state, "missing", undefined).prompt).toBeUndefined();
    const other = state.versions.find((v) => v.promptId !== version.promptId)!;
    expect(resolvePromptContext(state, version.promptId, other.id).version).toBeUndefined();
  });
  it("resolves a historical version without changing the user's draft", () => {
    const before = JSON.stringify(state.draft);
    expect(resolvePromptContext(state, version.promptId, version.id).version?.id).toBe(version.id);
    expect(JSON.stringify(state.draft)).toBe(before);
  });
  it("protects cleared content, title-only and descriptor-only edits when changing targets", () => {
    const copy = createInitialState();
    const v = copy.versions[0];
    const p = copy.prompts.find((p) => p.id === v.promptId)!;
    copy.draft = {
      promptId: p.id,
      parentVersionId: v.id,
      title: v.title,
      content: v.content,
      taskType: p.taskType,
      descriptor: p.descriptor,
    };
    expect(hasUnsavedDraft(copy, "en")).toBe(false);
    for (const patch of [
      { content: "" },
      { title: "Edited" },
      { descriptor: { purposes: [], tags: ["edited"] } },
    ]) {
      expect(hasUnsavedDraft({ ...copy, draft: { ...copy.draft, ...patch } }, "en")).toBe(true);
    }
  });
});
