import type { EvaluationReport, LayerState } from "@/lib/types";
import { saveEvaluationReport as saveEvaluationReportRecord } from "../repository";

function isEmptyScoreLayer(layer: LayerState) {
  return layer.score === null && layer.grade === null && layer.dimensions.length === 0;
}

/**
 * Keeps Evaluation Engine invariants at the application boundary. The service
 * deliberately does not calculate scores or merge the three evaluation layers.
 */
export function assertEvaluationInvariants(report: EvaluationReport) {
  if (report.layer3.status === "NOT_EXECUTED" && !isEmptyScoreLayer(report.layer3)) {
    throw Object.assign(new Error("NOT_EXECUTED cannot carry a score, grade, or dimensions."), {
      code: "EVALUATION_STATE_CONFLICT",
    });
  }

  if (report.layer2.status === "NOT_AVAILABLE" && !isEmptyScoreLayer(report.layer2)) {
    throw Object.assign(new Error("NOT_AVAILABLE cannot carry a score, grade, or dimensions."), {
      code: "EVALUATION_STATE_CONFLICT",
    });
  }

  if (report.layer1.score === null && report.layer1.grade !== null) {
    throw Object.assign(new Error("A null score cannot have a grade."), {
      code: "EVALUATION_STATE_CONFLICT",
    });
  }
}

export async function saveEvaluationReport(report: EvaluationReport) {
  assertEvaluationInvariants(report);
  return saveEvaluationReportRecord(report);
}
