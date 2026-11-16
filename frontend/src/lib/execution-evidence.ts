import type { AppState } from "./types";

type Run = AppState["playgroundRuns"][number];

// Execution evidence is separate from immutable historical EvaluationReports.
// A model label or arbitrary text alone never proves real execution.
export function isLiveExecutionEvidence(run: Run | undefined, versionId: string): run is Run {
  return (
    !!run &&
    run.versionId === versionId &&
    ["DEEPSEEK_LIVE_PLAYGROUND", "SILICONFLOW_LIVE_PLAYGROUND"].includes(run.source ?? "") &&
    !!run.executionId &&
    run.outputs.some((output) => output.source === run.source && !!output.text.trim())
  );
}

export function executionEvidenceFor(runs: Run[], versionId: string) {
  const run = runs.find((item) => isLiveExecutionEvidence(item, versionId));
  return {
    status: run ? ("EXECUTED_UNGRADED" as const) : ("NOT_EXECUTED" as const),
    score: null,
    grade: null,
    run,
  };
}

export function localizeFixtureOutput(name: string, output: string, locale: string) {
  if (locale !== "zh-CN" || !/^Demo Model [ABC]$/.test(name)) return output;
  return name.endsWith("A")
    ? "基于本地预置内容生成的结构化回复预览。"
    : "用于版式比较的另一条模拟回复。";
}
