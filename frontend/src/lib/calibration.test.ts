import { describe, expect, it } from "vitest";
import { layer1Rubric, candidateLayer2 } from "./calibration-rubric";
import {
  calculateLayer1,
  createCalibrationReport,
  emptyAssessments,
  validateAssessments,
  validateCalibrationReport,
} from "./calibration";
import { createInitialState } from "./fixtures";
import { reducer } from "./store";

const state = () => createInitialState();
const target = () => {
  const s = state();
  const p = s.prompts.find((p) => p.id === "prm_general_notes_01")!;
  return { s, p, v: s.versions.find((v) => v.id === p.currentVersionId)! };
};
const scored = () => {
  const { v } = target();
  return emptyAssessments().map((a) => ({
    ...a,
    status: "SCORED" as const,
    anchor: "Q4" as const,
    reason: "Synthetic arithmetic input; not an expert rating.",
    excerpt: v.content.slice(0, 20),
  }));
};

describe("local calibration contract (synthetic evidence, not empirical validity)", () => {
  it("retains the L1 baseline and four experimental L2 profiles", () => {
    expect(layer1Rubric.map((d) => d.weight)).toEqual([20, 20, 15, 15, 15, 15]);
    expect(layer1Rubric.every((d) => d.indicators.length === 4)).toBe(true);
    expect(
      Object.values(candidateLayer2).map((dims) => dims.reduce((n, d) => n + d.weight, 0)),
    ).toEqual([100, 100, 100, 100]);
  });
  it("aggregates complete applicable indicators without assigning a grade", () => {
    const a = scored();
    const anchorByDimension = ["Q5", "Q4", "Q3", "Q2", "Q1", "Q5"] as const;
    a.forEach((item, index) => {
      Object.assign(item, { anchor: anchorByDimension[Math.floor(index / 4)] });
    });
    expect(calculateLayer1(a).score).toBe(71.25);
    expect(calculateLayer1(a).grade).toBeNull();
  });
  it("does not renormalize missing information into an inflated score", () => {
    const a = scored();
    Object.assign(a[0], {
      status: "INSUFFICIENT_INFORMATION",
      anchor: "",
      reason: "Key attachment is unreadable.",
    });
    const result = calculateLayer1(a);
    expect(result.score).toBeNull();
    expect(result.dimensions[0].score).toBeNull();
    expect(result.dimensions[1].score).toBe(85);
  });
  it("excludes real N/A, and handles an entirely inapplicable dimension/layer", () => {
    const a = scored();
    a.slice(0, 4).forEach((item) => Object.assign(item, { status: "NOT_APPLICABLE", anchor: "" }));
    expect(calculateLayer1(a).score).toBe(85);
    expect(calculateLayer1(a).dimensions[0].state).toBe("NOT_APPLICABLE");
    a.forEach((item) => Object.assign(item, { status: "NOT_APPLICABLE", anchor: "" }));
    expect(calculateLayer1(a)).toMatchObject({
      status: "NOT_APPLICABLE",
      score: null,
      grade: null,
    });
  });
  it("keeps necessary verification unknown while allowing an auxiliary unverified outcome", () => {
    const a = scored();
    a[0].verificationPending = true;
    a[0].nonMaterialUnknown = "Actual outcome is unverified, but the instruction is visible.";
    expect(calculateLayer1(a).score).toBe(85);
    Object.assign(a[0], { status: "NOT_VERIFIED", anchor: "", nonMaterialUnknown: "" });
    expect(calculateLayer1(a)).toMatchObject({ status: "NOT_VERIFIED", score: null });
  });
  it("requires reasons and exact source quotes; translated text cannot masquerade as original", () => {
    const a = scored();
    a[0].reason = "";
    a[0].excerpt = "This quote is fabricated.";
    expect(validateAssessments(target().v.content, a)).toEqual(
      expect.arrayContaining([
        { indicatorId: a[0].indicatorId, code: "REASON" },
        { indicatorId: a[0].indicatorId, code: "EXCERPT" },
      ]),
    );
    expect(validateAssessments(target().v.content, a.slice(1))[0].code).toBe("STRUCTURE");
  });
  it("records observable omission without fabricating an excerpt", () => {
    const a = scored();
    a[0].evidenceKind = "OBSERVED_ABSENCE";
    a[0].excerpt = "";
    a[0].reason = "Synthetic fixture: reviewed full text for the necessary requirement.";
    expect(validateAssessments(target().v.content, a)).toEqual([]);
  });
  it("does not apply a second penalty or a cap for a critical defect", () => {
    const a = scored();
    a[0].criticalDefect = true;
    expect(calculateLayer1(a).score).toBe(85);
  });
  it("keeps General unavailable and execution unexecuted, without cross-layer total", () => {
    const { p, v } = target();
    const r = createCalibrationReport(p, v, scored());
    expect(r.layer2).toEqual({ status: "NOT_AVAILABLE", score: null, grade: null, dimensions: [] });
    expect(r.layer3).toEqual({ status: "NOT_EXECUTED", score: null, grade: null, dimensions: [] });
    expect(r).not.toHaveProperty("totalScore");
    expect(r.calibration!.rubric[0].indicators[0].id).toBe("L1_D1_I1");
  });
  it.each(["Data Analysis", "Business", "Research", "AI Agent"] as const)(
    "never scores the %s experimental profile",
    (taskType) => {
      const { p, v } = target();
      const r = createCalibrationReport({ ...p, taskType }, v, scored());
      expect(r.layer2.dimensions).toHaveLength(5);
      expect(r.layer2.score).toBeNull();
      expect(
        r.layer2.dimensions.every((d) => d.score === null && d.state === "PENDING REVIEW"),
      ).toBe(true);
    },
  );
  it("rejects cross-Prompt version references and corrupted persisted evidence", () => {
    const { p, v } = target();
    expect(() => createCalibrationReport({ ...p, id: "wrong" }, v, scored())).toThrow();
    const r = createCalibrationReport(p, v, scored());
    expect(validateCalibrationReport(r, v)).toBe(true);
    r.layer1.score = 100;
    expect(validateCalibrationReport(r, v)).toBe(false);
    expect(validateCalibrationReport({ ...r, layer3: undefined } as never, v)).toBe(false);
  });
  it("restores database JSONB snapshots regardless of object key ordering", () => {
    const { p, v } = target();
    const report = createCalibrationReport(p, v, scored());
    const reorderKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reorderKeys);
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => right.localeCompare(left))
            .map(([key, child]) => [key, reorderKeys(child)]),
        );
      }
      return value;
    };
    const databaseReport = JSON.parse(JSON.stringify(reorderKeys(report)));
    expect(validateCalibrationReport(databaseReport, v)).toBe(true);
  });
  it("appends reruns, preserving source reports, evidence and rubric snapshots", () => {
    const { s, p, v } = target();
    const before = structuredClone(s.reports);
    const next = reducer(s, {
      type: "CALIBRATE",
      promptId: p.id,
      versionId: v.id,
      assessments: scored(),
    });
    expect(next.reports).toHaveLength(before.length + 1);
    expect(next.reports.slice(1)).toEqual(before);
    const rerun = reducer(next, { type: "EVALUATE", promptId: p.id, versionId: v.id });
    expect(rerun.reports).toHaveLength(before.length + 2);
    expect(rerun.reports.slice(1)).toEqual(next.reports);
    const hydrated = reducer(s, { type: "HYDRATE", saved: next });
    expect(hydrated.reports).toEqual(next.reports);
  });
  it("keeps calibration identical across locale, mode and subscription changes", () => {
    const { s, p, v } = target();
    let next = reducer(s, {
      type: "CALIBRATE",
      promptId: p.id,
      versionId: v.id,
      assessments: scored(),
    });
    const snapshot = structuredClone(next.reports[0]);
    next = reducer(next, { type: "SET_MODE", mode: "professional" });
    next = reducer(next, { type: "SET_LOCALE", locale: "zh-CN" });
    next = reducer(next, { type: "SET_TIER", tier: "Pro" });
    expect(next.reports[0]).toEqual(snapshot);
  });
  it("does not create a report for invalid or unsaved source versions", () => {
    const { s, p, v } = target();
    const invalid = reducer(s, { type: "EVALUATE", promptId: p.id, versionId: "wrong" });
    expect(invalid.reports).toEqual(s.reports);
    const loaded = reducer(s, { type: "LOAD_PROMPT", promptId: p.id });
    const edited = reducer(loaded, {
      type: "SET_DRAFT",
      patch: { content: "Unsaved replacement" },
    });
    const rejected = reducer(edited, {
      type: "CALIBRATE",
      promptId: p.id,
      versionId: v.id,
      assessments: scored(),
    });
    expect(rejected.reports).toEqual(s.reports);
  });
});
