import { describe, expect, it } from "vitest";
import { createInitialState } from "./fixtures";
import { reducer } from "./store";

describe("PromptMaster mock data invariants", () => {
  it("saves an explicit optimization source without borrowing or replacing another dirty draft", () => {
    const original = createInitialState();
    const target = original.prompts[0];
    const prior = original.versions.find((v) => v.id === target.currentVersionId)!;
    original.draft = {
      promptId: "another-prompt",
      parentVersionId: "other-version",
      title: "Private draft title",
      content: "Unsaved private work",
      taskType: "Writing",
    };
    const saved = reducer(original, {
      type: "SAVE_VERSION",
      promptId: target.id,
      title: prior.title,
      baseVersionId: prior.id,
      parentVersionId: prior.id,
      source: "DEEPSEEK_OPTIMIZATION",
      optimizationId: "opt_context",
      content: "Improved target",
    });
    expect(saved.versions[0]).toMatchObject({
      promptId: target.id,
      title: prior.title,
      parentVersionId: prior.id,
      content: "Improved target",
    });
    expect(saved.draft).toEqual(original.draft);
  });

  it("preserves the historical parent when saving an explicit edit", () => {
    const original = createInitialState();
    const prompt = original.prompts.find((p) => p.id === "prm_writing_course_01")!;
    const historical = original.versions.find(
      (v) => v.promptId === prompt.id && v.id !== prompt.currentVersionId,
    )!;
    const saved = reducer(original, {
      type: "SAVE_VERSION",
      promptId: prompt.id,
      title: "Historical edit",
      baseVersionId: prompt.currentVersionId,
      parentVersionId: historical.id,
      source: "MANUAL_EDIT",
      content: "Revision from history",
    });
    expect(saved.versions[0]).toMatchObject({
      title: "Historical edit",
      parentVersionId: historical.id,
    });
  });

  it("loads the optimization target metadata instead of borrowing another Prompt's draft", () => {
    const original = createInitialState();
    const target = original.prompts[0];
    target.descriptor = { purposes: ["analyze"], tags: ["Target"] };
    original.draft = {
      promptId: "another-prompt",
      title: "Another title",
      content: "Another body",
      taskType: "Writing",
      descriptor: { purposes: ["create"], tags: ["Other"] },
    };
    const next = reducer(original, {
      type: "OPTIMIZE",
      promptId: target.id,
      content: "Proposed body",
    });
    expect(next.draft.descriptor).toEqual(target.descriptor);
    expect(next.draft.taskType).toBe(target.taskType);
    const edited = { ...next, draft: { ...next.draft, descriptor: { purposes: [], tags: [] } } };
    expect(
      reducer(edited, { type: "OPTIMIZE", promptId: target.id, content: "Next proposal" }).draft
        .descriptor,
    ).toEqual({ purposes: [], tags: [] });
  });

  it("keeps edited purposes in the saved prompt and loaded draft without changing the legacy rubric type", () => {
    const original = reducer(createInitialState(), {
      type: "LOAD_PROMPT",
      promptId: "prm_writing_course_01",
    });
    const descriptor = { purposes: ["analyze" as const], tags: ["经营复盘"] };
    const saved = reducer(original, {
      type: "SAVE_VERSION",
      source: "Edited",
      content: "Analyze the data",
      descriptor,
    });
    const prompt = saved.prompts.find((p) => p.id === original.draft.promptId)!;
    expect(prompt.descriptor).toEqual(descriptor);
    expect(prompt.taskType).toBe("Writing");
    expect(reducer(saved, { type: "LOAD_PROMPT", promptId: prompt.id }).draft.descriptor).toEqual(
      descriptor,
    );
  });
  it("retains independent descriptor metadata without changing the body", () => {
    const descriptor = { purposes: ["analyze", "create"] as const, tags: ["汇报"] };
    const state = reducer(createInitialState(), {
      type: "GENERATE",
      title: "跨领域需求",
      taskType: "General",
      content: "保留这份原始需求。",
      descriptor: { purposes: [...descriptor.purposes], tags: descriptor.tags },
    });
    expect(state.prompts[0].descriptor).toEqual(descriptor);
    expect(state.versions[0].content).toBe("保留这份原始需求。");
  });

  it("does not append a version when applying an unchanged optimization", () => {
    const original = reducer(createInitialState(), {
      type: "LOAD_PROMPT",
      promptId: "prm_writing_course_01",
    });
    const state = reducer(original, {
      type: "SAVE_VERSION",
      source: "DEEPSEEK_OPTIMIZATION",
      content: original.draft.content,
      optimizationId: "opt_unchanged",
    });
    expect(state.versions).toBe(original.versions);
    expect(state.history).toBe(original.history);
    expect(state.prompts).toBe(original.prompts);
    expect(state.notice).toContain("already clear");
  });
  it.each(["Free", "Pro"] as const)(
    "mode switching preserves every business field for %s",
    (tier) => {
      let state = reducer(createInitialState(), {
        type: "LOAD_PROMPT",
        promptId: "prm_writing_course_01",
      });
      state = reducer(state, { type: "SET_TIER", tier });
      state = reducer(state, {
        type: "SET_DRAFT",
        patch: { content: "Unsaved proposal / 未保存草稿" },
      });
      const original = state;
      for (const mode of ["professional", "simple"] as const) {
        state = reducer(state, { type: "SET_MODE", mode });
        expect(state.mode).toBe(mode);
        for (const key of Object.keys(original) as (keyof typeof original)[]) {
          if (key !== "mode" && key !== "notice") expect(state[key], key).toBe(original[key]);
        }
      }
    },
  );

  it("keeps General Layer 2 unavailable and Layer 3 unexecuted", () => {
    const state = createInitialState();
    const report = state.reports.find((item) => item.id === "evr_general_notes_01")!;
    expect(report.layer2).toMatchObject({
      status: "NOT_AVAILABLE",
      score: null,
      grade: null,
      dimensions: [],
    });
    expect(report.layer3).toMatchObject({ status: "NOT_EXECUTED", score: null, grade: null });
  });

  it("creates a new version on save and preserves the previous version", () => {
    let state = createInitialState();
    state = reducer(state, { type: "LOAD_PROMPT", promptId: "prm_writing_course_01" });
    const oldVersionId = state.draft.parentVersionId!;
    state = reducer(state, {
      type: "SAVE_VERSION",
      source: "Edited · simulated",
      content: "A revised prompt.",
    });
    expect(state.versions.some((item) => item.id === oldVersionId)).toBe(true);
    expect(
      state.versions.find(
        (item) =>
          item.id === state.prompts.find((p) => p.id === "prm_writing_course_01")?.currentVersionId,
      )?.content,
    ).toBe("A revised prompt.");
  });

  it("restores an older version by creating a new version, without reassigning old reports", () => {
    let state = createInitialState();
    const oldReportId = state.reports.find(
      (item) => item.versionId === "ver_writing_course_03",
    )!.id;
    state = reducer(state, {
      type: "RESTORE_VERSION",
      promptId: "prm_writing_course_01",
      versionId: "ver_writing_course_01",
    });
    const current = state.prompts.find(
      (item) => item.id === "prm_writing_course_01",
    )!.currentVersionId;
    expect(current).not.toBe("ver_writing_course_01");
    expect(state.versions.find((item) => item.id === current)?.content).toBe(
      state.versions.find((item) => item.id === "ver_writing_course_01")?.content,
    );
    expect(state.reports.find((item) => item.id === oldReportId)?.versionId).toBe(
      "ver_writing_course_03",
    );
  });

  it("does not create an approved score for an unreviewed task rubric", () => {
    let state = createInitialState();
    state = reducer(state, { type: "LOAD_PROMPT", promptId: "prm_data_sales_01" });
    state = reducer(state, {
      type: "EVALUATE",
      promptId: "prm_data_sales_01",
      versionId: "ver_data_sales_02",
    });
    const report = state.reports.find((item) => item.versionId === "ver_data_sales_02")!;
    expect(report.layer2.status).toBe("PENDING REVIEW");
    expect(report.layer2.score).toBeNull();
  });
});
