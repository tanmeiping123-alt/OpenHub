import "server-only";
import {
  parseEvaluationHandoff,
  selectedEvaluationAdvice,
  type EvaluationHandoff,
} from "@/lib/evaluation-handoff";
import { createHash, randomUUID } from "node:crypto";
import { withTransaction } from "../db";
import { AccountError } from "../accounts";
import { requireActor, assertActiveActor } from "./skill-library";
import { loadSkillContext, loadWorkflowContext } from "./skill-context";
import {
  analyzeSkillTask,
  matchSkillCandidates,
  WORKFLOW_LIMITS,
  type MatchingMode,
  type SkillSelection,
} from "@/lib/skill-workflow";
import type { Locale, TaskType } from "@/lib/types";
import { parsePromptDescriptor, type PromptDescriptor } from "@/lib/prompt-description";
import { generateLivePrompt, generateLiveSourceModel } from "../model/model-service";
import { ModelServiceError } from "../model/model-errors";
import type { PoolClient, QueryResultRow } from "pg";

async function reconcileRun(c: PoolClient, row: QueryResultRow) {
  if (row.status !== "RUNNING") return row;
  if (!row.execution_id) {
    const stopped = await c.query(
      "UPDATE skill_workflow_runs SET status='FAILED',error_code='WORKFLOW_INTERRUPTED_BEFORE_MODEL',completed_at=now() WHERE id=$1 AND owner_user_id=$2 AND status='RUNNING' AND execution_id IS NULL AND created_at<clock_timestamp()-interval '5 minutes' RETURNING *",
      [row.id, row.owner_user_id],
    );
    return stopped.rows[0] ?? row;
  }
  const execution = (
    await c.query(
      `SELECT m.*,v.title,p.task_type,o.id AS optimization_id FROM model_executions m LEFT JOIN prompt_versions v ON v.id=m.prompt_version_id AND v.owner_user_id=m.owner_user_id LEFT JOIN prompts p ON p.id=m.prompt_id AND p.owner_user_id=m.owner_user_id LEFT JOIN optimization_records o ON o.model_execution_id=m.id AND o.owner_user_id=m.owner_user_id WHERE m.id=$1 AND m.owner_user_id=$2`,
      [row.execution_id, row.owner_user_id],
    )
  ).rows[0];
  if (!execution || execution.status === "PENDING") return row;
  const e = execution;
  const result =
    e.status === "SUCCEEDED"
      ? {
          executionMode: "LIVE",
          purpose: e.purpose,
          executionId: e.id,
          promptId: e.prompt_id,
          versionId: e.prompt_version_id,
          title: e.title,
          taskType: e.task_type,
          content: e.output_text,
          provider: e.provider,
          requestedModel: e.requested_model,
          resolvedModel: e.resolved_model,
          productVersion: e.product_version,
          ...(e.requested_strength ? { strength: e.requested_strength } : {}),
          usage: {
            promptTokens: e.prompt_tokens,
            completionTokens: e.completion_tokens,
            totalTokens: e.total_tokens,
            ...(e.reasoning_tokens != null ? { reasoningTokens: e.reasoning_tokens } : {}),
          },
          latencyMs: e.latency_ms,
          ...(e.optimization_id ? { optimizationId: e.optimization_id } : {}),
        }
      : { executionId: e.id };
  const updated = await c.query(
    "UPDATE skill_workflow_runs SET status=$3,result=$4,error_code=$5,completed_at=now() WHERE id=$1 AND owner_user_id=$2 AND status='RUNNING' RETURNING *",
    [row.id, row.owner_user_id, e.status, JSON.stringify(result), e.error_code],
  );
  return (
    updated.rows[0] ??
    (
      await c.query("SELECT * FROM skill_workflow_runs WHERE id=$1 AND owner_user_id=$2", [
        row.id,
        row.owner_user_id,
      ])
    ).rows[0]
  );
}

export async function createSkillPlan(input: {
  evaluationHandoff?: EvaluationHandoff;
  goal?: string;
  source?: { promptId: string; versionId: string };
  taskType: TaskType;
  locale: Locale;
  matchingMode: MatchingMode;
  selectedVersionIds: string[];
  manualOverride?: boolean;
  deliveryPreference?: "AUTO" | "SINGLE_PROMPT" | "PROMPT_PACKAGE";
  responsibilities?: Record<string, string>;
  descriptor?: PromptDescriptor;
}) {
  const actor = requireActor();
  const descriptor =
    input.descriptor === undefined ? undefined : parsePromptDescriptor(input.descriptor);
  return withTransaction(async (c) => {
    await assertActiveActor(c, actor);
    if (input.source && input.goal !== undefined) throw new AccountError("INVALID_INPUT");
    const sourceVersion = input.source
      ? (
          await c.query(
            "SELECT v.content,p.task_type FROM prompt_versions v JOIN prompts p ON p.id=v.prompt_id AND p.owner_user_id=v.owner_user_id WHERE v.owner_user_id=$1 AND v.prompt_id=$2 AND v.id=$3",
            [actor.id, input.source.promptId, input.source.versionId],
          )
        ).rows[0]
      : undefined;
    if (input.source && !sourceVersion) throw new AccountError("PROMPT_VERSION_NOT_FOUND", 404);
    const goal = sourceVersion ? String(sourceVersion.content) : input.goal;
    if (!goal?.trim()) throw new AccountError("INVALID_INPUT");
    let reviewContext: string | undefined;
    let handoff: EvaluationHandoff | undefined;
    if (input.evaluationHandoff) {
      try {
        handoff = parseEvaluationHandoff(input.evaluationHandoff);
      } catch {
        throw new AccountError("INVALID_INPUT");
      }
      if (!input.source) throw new AccountError("INVALID_INPUT");
      const review = (
        await c.query(
          "SELECT evaluation_report FROM model_executions WHERE id=$1 AND owner_user_id=$2 AND prompt_id=$3 AND prompt_version_id=$4 AND purpose='EVALUATION_REPORT' AND status='SUCCEEDED'",
          [handoff.reportId, actor.id, input.source.promptId, input.source.versionId],
        )
      ).rows[0];
      if (!review?.evaluation_report) throw new AccountError("EVALUATION_REPORT_NOT_FOUND", 404);
      try {
        reviewContext = selectedEvaluationAdvice(review.evaluation_report, handoff.indexes);
      } catch {
        throw new AccountError("INVALID_INPUT");
      }
    }
    const taskType: TaskType = sourceVersion?.task_type ?? input.taskType;
    const explicitSelection =
      input.matchingMode === "MANUAL" ||
      (input.matchingMode === "HYBRID" &&
        (input.selectedVersionIds.length > 0 || input.manualOverride));
    const candidates = (
      await c.query(
        `SELECT v.id AS "versionId",v.metadata->>'name' AS name,v.metadata->>'description' AS description FROM skill_versions v JOIN skills k ON k.id=v.skill_id WHERE k.retired_at IS NULL AND (NOT $3::boolean OR v.id=ANY($4::text[])) AND ((EXISTS(SELECT 1 FROM skill_library_entries e WHERE e.version_id=v.id) AND NOT EXISTS(SELECT 1 FROM skill_library_withdrawals w WHERE w.version_id=v.id)) OR ($3::boolean AND EXISTS(SELECT 1 FROM skill_personal_access a WHERE a.version_id=v.id AND a.owner_user_id=$1))) ORDER BY v.id LIMIT $2`,
        [
          actor.id,
          WORKFLOW_LIMITS.candidates + 1,
          Boolean(explicitSelection),
          input.selectedVersionIds,
        ],
      )
    ).rows as { versionId: string; name: string; description: string }[];
    if (candidates.length > WORKFLOW_LIMITS.candidates)
      throw new AccountError("CANDIDATE_LIMIT_REFINE_REQUIRED");
    const analysis = analyzeSkillTask(goal, taskType, input.locale, input.deliveryPreference);
    const matching = matchSkillCandidates(
      goal,
      candidates,
      input.matchingMode,
      input.selectedVersionIds,
      input.locale,
      input.manualOverride,
    );
    if (matching.picked.length > WORKFLOW_LIMITS.skills) throw new AccountError("TOO_MANY_SKILLS");
    const selections: SkillSelection[] = [];
    for (const versionId of matching.picked) {
      if (!candidates.some((c) => c.versionId === versionId))
        throw new AccountError("SKILL_NOT_AVAILABLE", 403);
      const responsibility =
        input.responsibilities?.[versionId]?.trim() ||
        `Address only this task gap: ${matching.ranked.find((c) => c.versionId === versionId)?.reason ?? "User-selected reference; verify actual relevance"}. Use relevant methods from ${candidates.find((c) => c.versionId === versionId)!.name}; omit unrelated workflow and environment instructions`;
      selections.push((await loadSkillContext(c, actor, versionId, responsibility)).selection);
    }
    const id = `swp_${randomUUID()}`;
    const evidence = {
      ...analysis,
      contextVersion: "on-demand-v1",
      ...(handoff ? { evaluationHandoff: handoff, reviewContext } : {}),
      ...(input.source
        ? { source: { promptId: input.source.promptId, versionId: input.source.versionId } }
        : {}),
      ...(descriptor ? { descriptor } : {}),
      matching: {
        mode: input.matchingMode,
        manualOverride: input.manualOverride === true,
        candidates: matching.ranked,
        gaps: matching.gaps,
      },
      bounds: WORKFLOW_LIMITS,
      revisionPolicy:
        "Each explicit plan request creates an immutable revision; mode changes do not revise plans",
    };
    await c.query(
      "INSERT INTO skill_workflow_plans(id,owner_user_id,goal,task_type,locale,matching_mode,analysis,selections) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        id,
        actor.id,
        goal,
        taskType,
        input.locale,
        input.matchingMode,
        JSON.stringify(evidence),
        JSON.stringify(selections),
      ],
    );
    // Validate the total context budget before presenting a runnable plan.
    await loadWorkflowContext(c, id);
    return { id, analysis: evidence, selections };
  });
}
type RunInput = import("@/lib/model-catalog").ModelSelection & {
  planId: string;
  purpose: "PROMPT_GENERATION" | "OPTIMIZATION";
  promptId?: string;
  versionId?: string;
};
export async function runSkillPlan(input: RunInput, key: string, signal?: AbortSignal) {
  const actor = requireActor();
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        planId: input.planId,
        purpose: input.purpose,
        promptId: input.promptId ?? null,
        versionId: input.versionId ?? null,
        ...(input.modelKey !== undefined ? { modelKey: input.modelKey } : {}),
        ...(input.strength !== undefined ? { strength: input.strength } : {}),
        ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
      }),
    )
    .digest("hex");
  const reservation = await withTransaction(async (c) => {
    await assertActiveActor(c, actor);
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `skill-workflow:${actor.id}:${key}`,
    ]);
    const previous = (
      await c.query("SELECT * FROM skill_workflow_runs WHERE owner_user_id=$1 AND request_key=$2", [
        actor.id,
        key,
      ])
    ).rows[0];
    if (previous) {
      if (previous.payload_sha256 !== hash) throw new AccountError("IDEMPOTENCY_CONFLICT", 409);
      return { existing: await reconcileRun(c, previous) };
    }
    const plan = await loadWorkflowContext(c, input.planId);
    if (
      plan.source &&
      (input.purpose !== "OPTIMIZATION" ||
        plan.source.promptId !== input.promptId ||
        plan.source.versionId !== input.versionId)
    )
      throw new AccountError("PLAN_SOURCE_MISMATCH", 409);
    if (
      input.purpose === "OPTIMIZATION" &&
      !(
        await c.query(
          "SELECT 1 FROM prompt_versions WHERE owner_user_id=$1 AND prompt_id=$2 AND id=$3",
          [actor.id, input.promptId, input.versionId],
        )
      ).rowCount
    )
      throw new AccountError("PROMPT_VERSION_NOT_FOUND", 404);
    const id = `swr_${randomUUID()}`;
    await c.query(
      "INSERT INTO skill_workflow_runs(id,owner_user_id,request_key,payload_sha256,plan_id,status) VALUES($1,$2,$3,$4,$5,'RUNNING')",
      [id, actor.id, key, hash, input.planId],
    );
    return { id, plan };
  });
  if (reservation.existing) return reservation.existing;
  let result:
    | Awaited<ReturnType<typeof generateLivePrompt>>
    | Awaited<ReturnType<typeof generateLiveSourceModel>>;
  try {
    const plan = reservation.plan!;
    result =
      input.purpose === "PROMPT_GENERATION"
        ? await generateLivePrompt({
            goal: plan.goal,
            taskType: plan.taskType,
            locale: plan.locale,
            descriptor: plan.descriptor,
            skillPlanId: input.planId,
            skillRunId: reservation.id,
            modelKey: input.modelKey,
            strength: input.strength,
            maxOutputTokens: input.maxOutputTokens,
            signal,
          })
        : await generateLiveSourceModel({
            purpose: "OPTIMIZATION",
            promptId: input.promptId!,
            versionId: input.versionId!,
            locale: plan.locale,
            skillPlanId: input.planId,
            skillRunId: reservation.id,
            modelKey: input.modelKey,
            strength: input.strength,
            maxOutputTokens: input.maxOutputTokens,
            signal,
          });
  } catch (error) {
    const code =
      error instanceof ModelServiceError || error instanceof AccountError
        ? error.code
        : "WORKFLOW_FAILED";
    const evidence = error instanceof ModelServiceError ? { executionId: error.executionId } : null;
    await withTransaction((c) =>
      c.query(
        "UPDATE skill_workflow_runs SET status='FAILED',error_code=$3,result=$4,completed_at=now() WHERE id=$1 AND owner_user_id=$2 AND status='RUNNING'",
        [reservation.id, actor.id, code, JSON.stringify(evidence)],
      ),
    ).catch(() => undefined);
    // Never silently redispatch an unknown result; the persisted key is a reconciliation handle.
    return { id: reservation.id, status: "FAILED", error_code: code, result: evidence };
  }
  // The model service has already committed its output and bound execution_id.
  // A transient receipt write must leave that execution recoverable by the same key.
  await withTransaction((c) =>
    c.query(
      "UPDATE skill_workflow_runs SET status='SUCCEEDED',result=$3,completed_at=now() WHERE id=$1 AND owner_user_id=$2 AND status='RUNNING'",
      [reservation.id, actor.id, JSON.stringify(result)],
    ),
  ).catch(() => undefined);
  return { id: reservation.id, status: "SUCCEEDED", result };
}
export async function skillWorkflowStatus(key: string) {
  const actor = requireActor();
  return withTransaction(async (c) => {
    await assertActiveActor(c, actor);
    const row = (
      await c.query("SELECT * FROM skill_workflow_runs WHERE owner_user_id=$1 AND request_key=$2", [
        actor.id,
        key,
      ])
    ).rows[0];
    return row ? await reconcileRun(c, row) : null;
  });
}
