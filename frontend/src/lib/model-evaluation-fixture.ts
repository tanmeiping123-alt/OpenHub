// Synthetic report used only by tests; never a production/model fallback.
import { modelEvaluationPrinciples } from "./model-evaluation";
import type { TaskType } from "./types";
export function syntheticEvaluation(source: string, task: TaskType = "Writing") {
  const rules = modelEvaluationPrinciples(task, "en", source);
  const evidence = { kind: "EXCERPT", quote: source.slice(0, 35) };
  const finding = (id: string) => ({
    id,
    judgment: "PRESENT",
    reason: "Synthetic judgment, not a supplier evaluation.",
    evidence,
  });
  return {
    summary: "Synthetic report for workflow verification only.",
    layer1: rules.layer1.map((d) => finding(d.id)),
    layer2: rules.layer2.map((d) => finding(d.id)),
    suggestions: [
      {
        dimensionId: "L1_D6",
        priority: "HIGH",
        issue: "Synthetic verification suggestion",
        evidence,
        replacement: "State explicit acceptance checks and disclose unresolved assumptions.",
        rationale: "Synthetic rationale; no edits were applied.",
      },
    ],
    nextChecks: ["Review the proposed edit before saving a new version."],
  };
}
