import { workspaceOwnerId } from "../identity-context";
import "server-only";
import { randomUUID } from "node:crypto";
import type { TaskType } from "@/lib/types";
import type { PromptDescriptor } from "@/lib/prompt-description";
import { withTransaction } from "../db";
import { initializeDemoData } from "../repository";
import type { LiveModelConfig, ModelRequestKind, ProviderGenerateResult } from "./model-types";
import { finalizeModelQuota } from "./model-quota-repository";
import { loadWorkflowContext, recordExecutionSkillSources } from "../skills/skill-context";
import { lockCapacity, lockQuota } from "../billing/entitlements";
import { liveSource } from "@/lib/model-catalog";
import type { ModelEvaluation, modelEvaluationPrinciples } from "@/lib/model-evaluation";
import { ModelServiceError } from "./model-errors";
import { getPool } from "../db";
import type { QueryResultRow } from "pg";
import type { LiveSourceModelResult } from "./model-types";

export function savedPlaygroundResult(row: QueryResultRow): LiveSourceModelResult {
  return {
    executionMode: "LIVE",
    purpose: "PLAYGROUND",
    executionId: row.id,
    promptId: row.prompt_id,
    versionId: row.prompt_version_id,
    content: row.output_text,
    provider: row.provider,
    requestedModel: row.requested_model,
    resolvedModel: row.resolved_model,
    productVersion: row.product_version,
    ...(row.requested_strength ? { strength: row.requested_strength } : {}),
    ...(row.provider_request_id ? { providerRequestId: row.provider_request_id } : {}),
    ...(row.finish_reason ? { finishReason: row.finish_reason } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    usage: {
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      totalTokens: row.total_tokens,
      ...(row.prompt_cache_hit_tokens != null
        ? { promptCacheHitTokens: row.prompt_cache_hit_tokens }
        : {}),
      ...(row.prompt_cache_miss_tokens != null
        ? { promptCacheMissTokens: row.prompt_cache_miss_tokens }
        : {}),
      ...(row.reasoning_tokens != null ? { reasoningTokens: row.reasoning_tokens } : {}),
    },
    latencyMs: row.latency_ms,
    createdAt: new Date(row.completed_at).toISOString(),
  };
}

export type PlaygroundRequestStatus =
  | { status: "NOT_FOUND" }
  | { status: "PENDING" | "FAILED"; executionId: string; errorCode?: string }
  | { status: "SUCCEEDED"; executionId: string; result: LiveSourceModelResult };

export async function getPlaygroundRequestStatus(
  requestKey: string,
): Promise<PlaygroundRequestStatus> {
  // A recovery read must never seed data, reserve quota, or dispatch a supplier.
  const row = (
    await getPool().query(
      `SELECT m.*, (SELECT s.id FROM playground_sessions s WHERE s.model_execution_id=m.id
       AND s.owner_user_id=m.owner_user_id ORDER BY s.id LIMIT 1) AS session_id
     FROM model_executions m WHERE owner_user_id=$1 AND purpose='PLAYGROUND' AND playground_request_key=$2`,
      [workspaceOwnerId(), requestKey],
    )
  ).rows[0];
  if (!row) return { status: "NOT_FOUND" };
  if (row.status === "SUCCEEDED")
    return { status: "SUCCEEDED", executionId: row.id, result: savedPlaygroundResult(row) };
  return {
    status: row.status,
    executionId: row.id,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
  };
}

function newId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

export async function createPendingModelExecution(input: {
  config: LiveModelConfig;
  inputSha256: string;
  legacyInputSha256?: string;
  requestIdentitySha256?: string;
  legacyOutputIdentity?: (outputLimit: number) => string | undefined;
  policyVersion?: string;
  messagesSha256?: string;
  purpose: ModelRequestKind;
  promptId?: string;
  promptVersionId?: string;
  skillPlanId?: string;
  skillRunId?: string;
  evaluationRequestKey?: string;
  playgroundRequestKey?: string;
  evaluationPrinciples?: ReturnType<typeof modelEvaluationPrinciples>;
}) {
  await initializeDemoData();
  return withTransaction(async (client) => {
    const isPlayground = input.purpose === "PLAYGROUND" && !!input.playgroundRequestKey;
    const conflictClause = isPlayground
      ? "ON CONFLICT (owner_user_id,purpose,playground_request_key) WHERE purpose='PLAYGROUND' AND playground_request_key IS NOT NULL DO NOTHING"
      : "ON CONFLICT (owner_user_id,purpose,evaluation_request_key) WHERE purpose='EVALUATION_REPORT' AND evaluation_request_key IS NOT NULL DO NOTHING";
    const executionId = newId("mex");
    const createdAt = new Date().toISOString();
    const inserted = await client.query(
      `INSERT INTO model_executions
         (id, owner_user_id, purpose, execution_mode, status, provider, requested_model, product_version,
          input_sha256, prompt_id, prompt_version_id, created_at, requested_strength, output_token_limit, reasoning_token_reserve,
          evaluation_request_key, evaluation_principles, model_policy_version, dispatched_messages_sha256, request_identity_sha256, playground_request_key)
       VALUES ($1, $2, $3, 'LIVE', 'PENDING', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       ${conflictClause} RETURNING id`,
      [
        executionId,
        workspaceOwnerId(),
        input.purpose,
        input.config.provider,
        input.config.model,
        input.config.productVersion,
        input.inputSha256,
        input.promptId ?? null,
        input.promptVersionId ?? null,
        createdAt,
        input.config.strength ?? null,
        input.config.maxOutputTokens,
        input.config.reasoningTokenReserve ?? 0,
        input.evaluationRequestKey ?? null,
        input.evaluationPrinciples ? JSON.stringify(input.evaluationPrinciples) : null,
        input.policyVersion ?? null,
        input.messagesSha256 ?? null,
        input.requestIdentitySha256 ?? null,
        input.playgroundRequestKey ?? null,
      ],
    );
    if (!inserted.rowCount) {
      const previous = (
        await client.query(
          isPlayground
            ? `SELECT m.*, (SELECT s.id FROM playground_sessions s WHERE s.model_execution_id=m.id AND s.owner_user_id=m.owner_user_id ORDER BY s.id LIMIT 1) AS session_id
               FROM model_executions m WHERE owner_user_id=$1 AND purpose='PLAYGROUND' AND playground_request_key=$2`
            : "SELECT * FROM model_executions WHERE owner_user_id=$1 AND purpose='EVALUATION_REPORT' AND evaluation_request_key=$2",
          [
            workspaceOwnerId(),
            isPlayground ? input.playgroundRequestKey : input.evaluationRequestKey,
          ],
        )
      ).rows[0];
      if (
        !previous ||
        (previous.request_identity_sha256
          ? previous.request_identity_sha256 !== input.requestIdentitySha256 &&
            !(
              isPlayground &&
              previous.model_policy_version !== input.policyVersion &&
              previous.request_identity_sha256 ===
                input.legacyOutputIdentity?.(previous.output_token_limit)
            )
          : previous.input_sha256 !== (input.legacyInputSha256 ?? input.inputSha256)) ||
        previous.prompt_id !== input.promptId ||
        previous.prompt_version_id !== input.promptVersionId
      )
        throw new ModelServiceError(
          isPlayground ? "MODEL_PLAYGROUND_REQUEST_CONFLICT" : "MODEL_EVALUATION_REQUEST_CONFLICT",
          "This request key belongs to different source/settings. Start a new explicit request.",
          409,
        );
      if (previous.status !== "SUCCEEDED")
        throw new ModelServiceError(
          isPlayground
            ? previous.status === "PENDING"
              ? "MODEL_PLAYGROUND_PENDING"
              : "MODEL_PLAYGROUND_PREVIOUSLY_FAILED"
            : previous.status === "PENDING"
              ? "MODEL_EVALUATION_PENDING"
              : "MODEL_EVALUATION_PREVIOUSLY_FAILED",
          "This request is pending or previously failed. No supplier request was repeated. Recover saved records and check usage before explicitly starting a new request.",
          409,
          false,
          previous.id,
        );
      return {
        executionId: previous.id as string,
        createdAt: new Date(previous.created_at).toISOString(),
        replay: previous,
      };
    }
    if (input.skillPlanId) {
      const context = await loadWorkflowContext(client, input.skillPlanId);
      await client.query(
        "INSERT INTO skill_model_contexts(execution_id,owner_user_id,plan_id,selections) VALUES($1,$2,$3,$4)",
        [executionId, workspaceOwnerId(), input.skillPlanId, JSON.stringify(context.selections)],
      );
    }
    if (input.skillRunId) {
      const bound = await client.query(
        "UPDATE skill_workflow_runs SET execution_id=$3 WHERE id=$1 AND owner_user_id=$2 AND plan_id=$4 AND status='RUNNING' AND execution_id IS NULL",
        [input.skillRunId, workspaceOwnerId(), executionId, input.skillPlanId],
      );
      if (!bound.rowCount)
        throw Object.assign(new Error("Workflow execution binding failed"), {
          code: "WORKFLOW_BINDING_CONFLICT",
        });
    }
    return { executionId, createdAt };
  });
}

export async function failModelExecution(
  executionId: string,
  input: { code: string; message: string; latencyMs?: number; result?: ProviderGenerateResult },
) {
  await withTransaction(async (client) => {
    const failed = await client.query(
      `UPDATE model_executions
       SET status = 'FAILED', error_code = $1, error_message = $2, latency_ms = $3, completed_at = now(),
           output_text = $6, resolved_model = $7, provider_request_id = $8,
           prompt_tokens = $9, completion_tokens = $10, total_tokens = $11,
           prompt_cache_hit_tokens = $12, prompt_cache_miss_tokens = $13, reasoning_tokens = $14,
           finish_reason = $15, system_fingerprint = $16
       WHERE id = $4 AND owner_user_id = $5 AND status = 'PENDING' RETURNING id`,
      [
        input.code,
        input.message.slice(0, 1000),
        input.latencyMs ?? null,
        executionId,
        workspaceOwnerId(),
        input.result?.content ?? null,
        input.result?.resolvedModel ?? null,
        input.result?.providerRequestId ?? null,
        input.result?.usage.promptTokens ?? null,
        input.result?.usage.completionTokens ?? null,
        input.result?.usage.totalTokens ?? null,
        input.result?.usage.promptCacheHitTokens ?? null,
        input.result?.usage.promptCacheMissTokens ?? null,
        input.result?.usage.reasoningTokens ?? null,
        input.result?.finishReason ?? null,
        input.result?.systemFingerprint ?? null,
      ],
    );
    if (failed.rowCount)
      await finalizeModelQuota(client, executionId, workspaceOwnerId(), input.result?.usage);
  });
}

export async function completeModelExecutionWithPrompt(input: {
  executionId: string;
  title: string;
  taskType: TaskType;
  descriptor?: PromptDescriptor;
  result: ProviderGenerateResult;
}) {
  return withTransaction(async (client) => {
    const execution = await client.query(
      "SELECT status, provider FROM model_executions WHERE id = $1 AND owner_user_id = $2 FOR UPDATE",
      [input.executionId, workspaceOwnerId()],
    );
    if (execution.rows[0]?.status !== "PENDING") {
      throw Object.assign(new Error("Model execution is not pending."), {
        code: "MODEL_EXECUTION_STATE_CONFLICT",
      });
    }
    await lockQuota(client);
    await lockCapacity(client, workspaceOwnerId());
    const promptId = newId("prm");
    const versionId = newId("ver");
    const historyId = newId("his");
    const completedAt = new Date().toISOString();
    const provider = execution.rows[0].provider;
    const source = liveSource(provider, "GENERATION");
    await client.query(
      `INSERT INTO prompts
         (id, owner_user_id, kind, title, task_type, description, current_version_id, created_at, updated_at, descriptor)
       VALUES ($1, $2, 'PERSONAL_PROMPT', $3, $4, $5, $6, $7, $7, $8)`,
      [
        promptId,
        workspaceOwnerId(),
        input.title,
        input.taskType,
        `Generated by ${provider} live model execution.`,
        versionId,
        completedAt,
        input.descriptor ? JSON.stringify(input.descriptor) : null,
      ],
    );
    await client.query(
      `INSERT INTO prompt_versions
         (id, prompt_id, owner_user_id, version_number, title, content, created_by, source, created_at)
       VALUES ($1, $2, $3, 1, $4, $5, $7, $8, $6)`,
      [
        versionId,
        promptId,
        workspaceOwnerId(),
        input.title,
        input.result.content,
        completedAt,
        `${provider}-live`,
        source,
      ],
    );
    await client.query(
      `INSERT INTO history_records
         (id, owner_user_id, prompt_id, prompt_version_id, source, created_at)
       VALUES ($1, $2, $3, $4, $6, $5)`,
      [historyId, workspaceOwnerId(), promptId, versionId, completedAt, source],
    );
    await client.query(
      `UPDATE model_executions
       SET status = 'SUCCEEDED', resolved_model = $1, provider_request_id = $2,
           system_fingerprint = $3, output_text = $4, prompt_id = $5, prompt_version_id = $6,
           prompt_tokens = $7, completion_tokens = $8, total_tokens = $9,
           prompt_cache_hit_tokens = $10, prompt_cache_miss_tokens = $11,
           finish_reason = $12, latency_ms = $13, completed_at = $14, reasoning_tokens = $17
       WHERE id = $15 AND owner_user_id = $16 AND status = 'PENDING'`,
      [
        input.result.resolvedModel,
        input.result.providerRequestId ?? null,
        input.result.systemFingerprint ?? null,
        input.result.content,
        promptId,
        versionId,
        input.result.usage.promptTokens,
        input.result.usage.completionTokens,
        input.result.usage.totalTokens,
        input.result.usage.promptCacheHitTokens ?? null,
        input.result.usage.promptCacheMissTokens ?? null,
        input.result.finishReason ?? null,
        input.result.latencyMs,
        completedAt,
        input.executionId,
        workspaceOwnerId(),
        input.result.usage.reasoningTokens ?? null,
      ],
    );
    await finalizeModelQuota(client, input.executionId, workspaceOwnerId(), input.result.usage);
    await recordExecutionSkillSources(client, input.executionId, versionId);
    return { promptId, versionId, completedAt };
  });
}

export async function completeSourceModelExecution(input: {
  executionId: string;
  purpose: Exclude<ModelRequestKind, "PROMPT_GENERATION">;
  promptId: string;
  promptVersionId: string;
  result: ProviderGenerateResult;
  evaluation?: ModelEvaluation;
}) {
  return withTransaction(async (client) => {
    const execution = await client.query(
      `SELECT status, purpose, prompt_id, prompt_version_id, provider
       FROM model_executions WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
      [input.executionId, workspaceOwnerId()],
    );
    const row = execution.rows[0];
    if (
      row?.status !== "PENDING" ||
      row.purpose !== input.purpose ||
      row.prompt_id !== input.promptId ||
      row.prompt_version_id !== input.promptVersionId
    ) {
      throw Object.assign(
        new Error(
          "Source model execution is not pending or is not bound to the requested version.",
        ),
        {
          code: "MODEL_EXECUTION_STATE_CONFLICT",
        },
      );
    }

    const completedAt = new Date().toISOString();
    await client.query(
      `UPDATE model_executions
       SET status = 'SUCCEEDED', resolved_model = $1, provider_request_id = $2,
           system_fingerprint = $3, output_text = $4, prompt_tokens = $5,
           completion_tokens = $6, total_tokens = $7, prompt_cache_hit_tokens = $8,
           prompt_cache_miss_tokens = $9, finish_reason = $10, latency_ms = $11,
           completed_at = $12, reasoning_tokens = $15, evaluation_report = $16
       WHERE id = $13 AND owner_user_id = $14 AND status = 'PENDING'`,
      [
        input.result.resolvedModel,
        input.result.providerRequestId ?? null,
        input.result.systemFingerprint ?? null,
        input.result.content,
        input.result.usage.promptTokens,
        input.result.usage.completionTokens,
        input.result.usage.totalTokens,
        input.result.usage.promptCacheHitTokens ?? null,
        input.result.usage.promptCacheMissTokens ?? null,
        input.result.finishReason ?? null,
        input.result.latencyMs,
        completedAt,
        input.executionId,
        workspaceOwnerId(),
        input.result.usage.reasoningTokens ?? null,
        input.evaluation ? JSON.stringify(input.evaluation) : null,
      ],
    );

    await finalizeModelQuota(client, input.executionId, workspaceOwnerId(), input.result.usage);

    if (input.purpose === "OPTIMIZATION") {
      const optimizationId = newId("opt");
      await client.query(
        `INSERT INTO optimization_records
           (id, owner_user_id, prompt_id, source_prompt_version_id, proposed_content, source, model_execution_id)
         VALUES ($1, $2, $3, $4, $5, $7, $6)`,
        [
          optimizationId,
          workspaceOwnerId(),
          input.promptId,
          input.promptVersionId,
          input.result.content,
          input.executionId,
          liveSource(row.provider, "OPTIMIZATION"),
        ],
      );
      return { completedAt, optimizationId };
    }

    if (input.purpose === "PLAYGROUND") {
      const sessionId = newId("pls");
      await client.query(
        `INSERT INTO playground_sessions
           (id, owner_user_id, prompt_id, prompt_version_id, source, model_execution_id)
         VALUES ($1, $2, $3, $4, $6, $5)`,
        [
          sessionId,
          workspaceOwnerId(),
          input.promptId,
          input.promptVersionId,
          input.executionId,
          liveSource(row.provider, "PLAYGROUND"),
        ],
      );
      await client.query(
        `INSERT INTO model_comparison_results
           (session_id, sort_order, model_label, output_text, source)
         VALUES ($1, 0, $2, $3, $4)`,
        [
          sessionId,
          `${row.provider} · ${input.result.resolvedModel}`,
          input.result.content,
          liveSource(row.provider, "PLAYGROUND"),
        ],
      );
      return { completedAt, sessionId };
    }

    return { completedAt };
  });
}
