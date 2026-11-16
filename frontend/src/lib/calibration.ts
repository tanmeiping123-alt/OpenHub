import { anchors, CALIBRATION_VERSION, candidateLayer2, layer1Rubric } from "./calibration-rubric";
import type { DimensionDefinition } from "./calibration-rubric";
import type { EvaluationReport, LayerState, Prompt, PromptVersion } from "./types";

export type Assessment = {
  indicatorId: string;
  status: "SCORED" | "NOT_APPLICABLE" | "INSUFFICIENT_INFORMATION" | "NOT_VERIFIED";
  anchor: "Q1" | "Q2" | "Q3" | "Q4" | "Q5" | "";
  reason: string;
  evidenceKind: "EXCERPT" | "OBSERVED_ABSENCE";
  excerpt: string;
  nonMaterialUnknown: string;
  verificationPending: boolean;
  criticalDefect: boolean;
};
export type CalibrationSnapshot = {
  contract: "human-calibration-v1";
  rubricVersion: string;
  rubric: DimensionDefinition[];
  assessedText: string;
  taskType: Prompt["taskType"];
  assessments: Assessment[];
};
export type CalibrationError = {
  indicatorId: string;
  code: "STRUCTURE" | "REASON" | "ANCHOR" | "EXCERPT" | "EVIDENCE_KIND";
};
export const emptyAssessments = (): Assessment[] =>
  layer1Rubric.flatMap((d) =>
    d.indicators.map((i) => ({
      indicatorId: i.id,
      status: "INSUFFICIENT_INFORMATION",
      anchor: "",
      reason: "",
      evidenceKind: "EXCERPT",
      excerpt: "",
      nonMaterialUnknown: "",
      verificationPending: false,
      criticalDefect: false,
    })),
  );

// No text heuristics, checkpoint vote counts or model calls: a reviewer supplies every judgment.
export function validateAssessments(text: string, assessments: Assessment[]): CalibrationError[] {
  const ids = layer1Rubric.flatMap((d) => d.indicators.map((i) => i.id));
  if (
    !Array.isArray(assessments) ||
    assessments.length !== ids.length ||
    new Set(assessments.map((a) => a?.indicatorId)).size !== ids.length ||
    assessments.some((a) => !a || !ids.includes(a.indicatorId))
  )
    return [{ indicatorId: "", code: "STRUCTURE" }];
  const errors: CalibrationError[] = [];
  for (const a of assessments) {
    const add = (code: CalibrationError["code"]) =>
      errors.push({ indicatorId: a.indicatorId, code });
    if (
      !["SCORED", "NOT_APPLICABLE", "INSUFFICIENT_INFORMATION", "NOT_VERIFIED"].includes(
        a.status,
      ) ||
      typeof a.reason !== "string" ||
      typeof a.excerpt !== "string" ||
      typeof a.nonMaterialUnknown !== "string" ||
      typeof a.verificationPending !== "boolean" ||
      typeof a.criticalDefect !== "boolean"
    ) {
      add("STRUCTURE");
      continue;
    }
    if (!a.reason.trim()) add("REASON");
    if (a.status === "SCORED") {
      if (!anchors.some((anchor) => anchor.id === a.anchor)) add("ANCHOR");
      if (!["EXCERPT", "OBSERVED_ABSENCE"].includes(a.evidenceKind)) add("EVIDENCE_KIND");
      if (a.evidenceKind === "EXCERPT" && (!a.excerpt.trim() || !text.includes(a.excerpt)))
        add("EXCERPT");
      // OBSERVED_ABSENCE records review of the entire exact version, not a fabricated quote.
    } else if (a.anchor !== "" || a.criticalDefect || a.nonMaterialUnknown !== "") add("STRUCTURE");
  }
  return errors;
}

function aggregate(items: { weight: number; score: number | null; status: string }[]) {
  const applicable = items.filter((item) => item.status !== "NOT_APPLICABLE");
  if (!applicable.length) return { status: "NOT_APPLICABLE", score: null };
  if (applicable.some((item) => item.score === null))
    return {
      status: applicable.some((item) => item.status === "INSUFFICIENT_INFORMATION")
        ? "INSUFFICIENT_INFORMATION"
        : "NOT_VERIFIED",
      score: null,
    };
  const total = applicable.reduce((n, item) => n + item.weight, 0);
  return {
    status: "CANDIDATE_SCORED",
    score: applicable.reduce((n, item) => n + item.weight * item.score!, 0) / total,
  };
}

export function calculateLayer1(assessments: Assessment[]): LayerState {
  const dimensions = layer1Rubric.map((dimension) => {
    const items = dimension.indicators.map((indicator) => {
      const a = assessments.find((item) => item.indicatorId === indicator.id)!;
      return {
        weight: 25,
        status: a.status,
        score:
          a.status === "SCORED" ? anchors.find((anchor) => anchor.id === a.anchor)!.score : null,
      };
    });
    const result = aggregate(items);
    return {
      name: dimension.name.en,
      weight: dimension.weight,
      score: result.score,
      state: result.status,
      reason: "Local human calibration; see indicator evidence and reasons.",
    };
  });
  const result = aggregate(dimensions.map((d) => ({ ...d, status: d.state })));
  return { ...result, grade: null, dimensions };
}

export function createCalibrationReport(
  prompt: Prompt,
  version: PromptVersion,
  assessments: Assessment[],
): EvaluationReport {
  if (prompt.id !== version.promptId || validateAssessments(version.content, assessments).length)
    throw new Error("Invalid calibration evidence or version reference");
  const profile = candidateLayer2[prompt.taskType];
  return {
    id: `evr_cal_${crypto.randomUUID()}`,
    promptId: prompt.id,
    versionId: version.id,
    createdAt: new Date().toISOString(),
    source: "LOCAL_HUMAN_CALIBRATION",
    rubricVersion: CALIBRATION_VERSION,
    calibration: {
      contract: "human-calibration-v1",
      rubricVersion: CALIBRATION_VERSION,
      rubric: structuredClone(layer1Rubric),
      assessedText: version.content,
      taskType: prompt.taskType,
      assessments: structuredClone(assessments),
    },
    layer1: calculateLayer1(assessments),
    layer2:
      prompt.taskType === "General"
        ? { status: "NOT_AVAILABLE", score: null, grade: null, dimensions: [] }
        : {
            status: "PENDING REVIEW",
            score: null,
            grade: null,
            dimensions: (profile ?? []).map((d) => ({
              name: d.name.en,
              weight: d.weight,
              score: null,
              state: "PENDING REVIEW",
              reason: "Experimental profile only; no task score is calculated.",
            })),
          },
    layer3: { status: "NOT_EXECUTED", score: null, grade: null, dimensions: [] },
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function validateCalibrationReport(
  report: EvaluationReport,
  version: PromptVersion,
): boolean {
  try {
    const c = report.calibration;
    if (
      !c ||
      c.contract !== "human-calibration-v1" ||
      c.rubricVersion !== CALIBRATION_VERSION ||
      report.rubricVersion !== c.rubricVersion ||
      c.assessedText !== version.content ||
      stableJson(c.rubric) !== stableJson(layer1Rubric)
    )
      return false;
    if (validateAssessments(version.content, c.assessments).length) return false;
    return (
      report.promptId === version.promptId &&
      report.versionId === version.id &&
      stableJson(report.layer1) === stableJson(calculateLayer1(c.assessments)) &&
      report.layer3.status === "NOT_EXECUTED" &&
      report.layer3.score === null &&
      report.layer3.grade === null &&
      report.layer3.dimensions.length === 0 &&
      report.layer2.score === null &&
      report.layer2.grade === null &&
      (c.taskType === "General"
        ? report.layer2.status === "NOT_AVAILABLE" && report.layer2.dimensions.length === 0
        : report.layer2.status === "PENDING REVIEW" &&
          report.layer2.dimensions.every((d) => d.score === null))
    );
  } catch {
    return false;
  }
}
