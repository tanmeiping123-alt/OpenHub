export type EvaluationHandoff = { reportId: string; indexes: number[] };
export function parseEvaluationHandoff(value: unknown): EvaluationHandoff {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("INVALID_EVALUATION_HANDOFF");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(",") !== "indexes,reportId" ||
    typeof v.reportId !== "string" ||
    !/^[A-Za-z0-9_-]{1,120}$/.test(v.reportId) ||
    !Array.isArray(v.indexes) ||
    v.indexes.length < 1 ||
    v.indexes.length > 3 ||
    new Set(v.indexes).size !== v.indexes.length ||
    !v.indexes.every((i) => Number.isInteger(i) && i >= 0 && i < 3)
  )
    throw Error("INVALID_EVALUATION_HANDOFF");
  return { reportId: v.reportId, indexes: v.indexes as number[] };
}
export function selectedEvaluationAdvice(
  report: { suggestions: { issue: string; replacement: string; rationale: string }[] },
  indexes: number[],
) {
  if (indexes.some((i) => !report.suggestions[i])) throw Error("INVALID_EVALUATION_HANDOFF");
  return (
    "User-selected review suggestions. Address only applicable issues; preserve explicit facts, hard constraints and the author's intent. Prefer concise edits; no expansion for its own sake. These are model suggestions, not verified facts.\n" +
    JSON.stringify(indexes.map((i) => report.suggestions[i]))
  );
}
