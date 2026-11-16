import "server-only";
import { createHash } from "node:crypto";
import { generateWithChatModel } from "./deepseek-provider";
import { prepareModelDispatch, sha256 } from "./model-policy";
import { catalogModel, type ModelSelection } from "@/lib/model-catalog";
import { readModelConfig } from "./model-config";
import { ModelServiceError } from "./model-errors";
import {
  completeModelExecutionWithPrompt,
  completeSourceModelExecution,
  createPendingModelExecution,
  failModelExecution,
  savedPlaygroundResult,
} from "./model-repository";
import {
  getModelQuotaSummary,
  markModelAttempt,
  reserveModelQuota,
} from "./model-quota-repository";
import type {
  LivePromptGenerationResult,
  LiveSourceModelResult,
  ModelGenerateInput,
  ModelRequestKind,
  ProviderGenerateResult,
} from "./model-types";
import { getPromptForEvaluation, getPromptVersion } from "../services/prompt-service";
import { withTransaction } from "../db";
import { loadWorkflowContext } from "../skills/skill-context";
import {
  legacyModelEvaluationPrinciples,
  modelEvaluationPrinciples,
  parseModelEvaluation,
} from "@/lib/model-evaluation";
import { getPool } from "../db";
import { workspaceOwnerId } from "../identity-context";

function inputHash(input: ModelGenerateInput) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        goal: input.goal,
        taskType: input.taskType,
        locale: input.locale,
        kind: input.kind ?? "PROMPT_GENERATION",
        sourceContent: input.sourceContent,
        skillPlanId: input.skillPlanId,
        skillContext: input.skillContext,
        modelKey: input.modelKey,
        strength: input.strength,
        maxOutputTokens: input.maxOutputTokens,
        evaluationPrinciples: input.evaluationPrinciples,
      }),
    )
    .digest("hex");
}

function titleFor(goal: string) {
  return goal.trim().replace(/\s+/g, " ").slice(0, 56);
}

export async function generateLivePrompt(
  input: ModelGenerateInput,
): Promise<LivePromptGenerationResult> {
  if (input.skillPlanId) {
    const context = await withTransaction((c) => loadWorkflowContext(c, input.skillPlanId!));
    input = {
      ...input,
      goal: context.goal,
      taskType: context.taskType,
      locale: context.locale,
      skillContext: context.text,
      taskPlanContext: context.taskPlanContext,
      descriptor: context.descriptor,
    };
  } else input = { ...input, skillContext: undefined, taskPlanContext: undefined };
  input = { ...input, kind: "PROMPT_GENERATION" };
  const config = readModelConfig(process.env, input, input);
  if (config.mode === "DISABLED") {
    throw new ModelServiceError(
      "MODEL_SERVICE_DISABLED",
      "Live model execution is disabled on this server.",
      503,
    );
  }

  const dispatch = prepareModelDispatch(input, config);
  const pending = await createPendingModelExecution({
    config,
    inputSha256: dispatch.inputSha256,
    policyVersion: dispatch.policyVersion,
    messagesSha256: dispatch.messagesSha256,
    purpose: "PROMPT_GENERATION",
    skillPlanId: input.skillPlanId,
    skillRunId: input.skillRunId,
  });
  const startedAt = Date.now();
  let receivedResult: ProviderGenerateResult | undefined;
  try {
    await reserveModelQuota({
      executionId: pending.executionId,
      config,
      serializedMessages: dispatch.serializedMessages,
    });

    const result = await generateWithChatModel(
      config,
      { ...input, kind: "PROMPT_GENERATION" },
      {
        messages: dispatch.messages,
        beforeAttempt: async () => {
          if (input.skillPlanId)
            await withTransaction((c) => loadWorkflowContext(c, input.skillPlanId!));
          await markModelAttempt(pending.executionId);
        },
      },
    );
    receivedResult = result;
    const created = await completeModelExecutionWithPrompt({
      executionId: pending.executionId,
      title: titleFor(input.goal),
      taskType: input.taskType,
      descriptor: input.descriptor,
      result,
    });
    return {
      executionMode: "LIVE",
      executionId: pending.executionId,
      promptId: created.promptId,
      versionId: created.versionId,
      title: titleFor(input.goal),
      taskType: input.taskType,
      content: result.content,
      provider: config.provider,
      requestedModel: config.model,
      resolvedModel: result.resolvedModel,
      productVersion: config.productVersion,
      strength: config.strength,
      ...(result.providerRequestId ? { providerRequestId: result.providerRequestId } : {}),
      ...(result.finishReason ? { finishReason: result.finishReason } : {}),
      usage: result.usage,
      latencyMs: result.latencyMs,
    };
  } catch (error) {
    const serviceError =
      error instanceof ModelServiceError
        ? error.withExecutionId(pending.executionId)
        : new ModelServiceError(
            "MODEL_SERVICE_FAILED",
            "The live model request failed before it could be saved.",
            503,
            false,
            pending.executionId,
          );
    await failModelExecution(pending.executionId, {
      code: serviceError.code,
      message: serviceError.message,
      latencyMs: Date.now() - startedAt,
      result: receivedResult ?? serviceError.providerResult,
    }).catch(() => undefined);
    throw serviceError;
  }
}

export type LiveSourceModelInput = ModelSelection & {
  evaluationRequestKey?: string;
  playgroundRequestKey?: string;
  purpose: Exclude<ModelRequestKind, "PROMPT_GENERATION">;
  promptId: string;
  versionId: string;
  locale: "en" | "zh-CN";
  signal?: AbortSignal;
  skillPlanId?: string;
  skillRunId?: string;
};

export async function generateLiveSourceModel(
  input: LiveSourceModelInput,
): Promise<LiveSourceModelResult> {
  const isEvaluation = input.purpose === "EVALUATION_REPORT";
  const isPlayground = input.purpose === "PLAYGROUND";
  // Preserve old request identities when no new settings were supplied. New
  // explicit report choices belong to the recovery key and cannot be changed.
  const reportSettings =
    input.modelKey === undefined || input.modelKey === "deepseek-direct"
      ? {
          ...(input.strength !== undefined ? { strength: input.strength } : {}),
          ...(input.maxOutputTokens !== undefined
            ? { maxOutputTokens: input.maxOutputTokens }
            : {}),
        }
      : {};
  if (
    input.playgroundRequestKey !== undefined &&
    (!isPlayground || !/^[A-Za-z0-9_-]{8,100}$/.test(input.playgroundRequestKey))
  )
    throw new ModelServiceError(
      "INVALID_LIVE_PLAYGROUND_INPUT",
      "A safe Playground request key is required.",
      400,
    );
  if (isEvaluation) {
    if (!input.evaluationRequestKey || !/^[A-Za-z0-9_-]{8,100}$/.test(input.evaluationRequestKey))
      throw new ModelServiceError(
        "INVALID_MODEL_EVALUATION_REQUEST",
        "An explicit evaluation request key is required.",
        400,
      );
    // This report endpoint is intentionally direct DeepSeek; arbitrary connection
    // settings, Skills and model overrides cannot enter the judging context.
    input = {
      ...input,
      modelKey: "deepseek-direct",
      strength: reportSettings.strength ?? "off",
      maxOutputTokens: reportSettings.maxOutputTokens,
      skillPlanId: undefined,
      skillRunId: undefined,
    };
  }
  const prompt = await getPromptForEvaluation(input.promptId);
  if (!prompt) {
    throw new ModelServiceError("PROMPT_NOT_FOUND", "The requested Prompt was not found.", 404);
  }
  const version = await getPromptVersion(input.promptId, input.versionId);
  if (!version) {
    throw new ModelServiceError(
      "PROMPT_VERSION_NOT_FOUND",
      "The requested PromptVersion was not found.",
      404,
    );
  }

  const providerInput: ModelGenerateInput = {
    goal: version.content,
    taskType: prompt.taskType,
    locale: input.locale,
    kind: input.purpose,
    sourceContent: version.content,
    signal: input.signal,
    modelKey: input.modelKey,
    strength: input.strength,
    maxOutputTokens: input.maxOutputTokens,
    ...(isEvaluation
      ? {
          evaluationPrinciples: modelEvaluationPrinciples(
            prompt.taskType,
            input.locale,
            version.content,
          ),
        }
      : {}),
  };
  if (input.skillPlanId) {
    const context = await withTransaction((c) => loadWorkflowContext(c, input.skillPlanId!));
    providerInput.goal = context.goal;
    providerInput.skillContext = context.text;
    providerInput.taskPlanContext = context.taskPlanContext;
    providerInput.goalInSource = Boolean(
      context.source &&
      context.source.promptId === input.promptId &&
      context.source.versionId === input.versionId &&
      context.goal === version.content,
    );
    providerInput.skillPlanId = input.skillPlanId;
  }
  const config = readModelConfig(process.env, input, providerInput);
  if (config.mode === "DISABLED") {
    throw new ModelServiceError(
      "MODEL_SERVICE_DISABLED",
      "Live model execution is disabled on this server.",
      503,
    );
  }
  if (isEvaluation || isPlayground) config.maxRetries = 0;
  const playgroundIdentity = (maxOutputTokens: number) =>
    sha256(
      JSON.stringify({
        owner: workspaceOwnerId(),
        purpose: input.purpose,
        promptId: input.promptId,
        versionId: input.versionId,
        locale: input.locale,
        modelKey: catalogModel(input.modelKey)?.key,
        provider: config.provider,
        model: config.model,
        productVersion: config.productVersion,
        strength: config.strength ?? null,
        maxOutputTokens,
      }),
    );
  const dispatch = prepareModelDispatch(providerInput, config);
  const pending = await createPendingModelExecution({
    config,
    inputSha256: dispatch.inputSha256,
    policyVersion: dispatch.policyVersion,
    messagesSha256: dispatch.messagesSha256,
    purpose: input.purpose,
    promptId: input.promptId,
    promptVersionId: input.versionId,
    skillPlanId: input.skillPlanId,
    skillRunId: input.skillRunId,
    ...(isPlayground && input.playgroundRequestKey
      ? {
          playgroundRequestKey: input.playgroundRequestKey,
          requestIdentitySha256: playgroundIdentity(config.maxOutputTokens),
          legacyOutputIdentity: (limit: number) =>
            input.maxOutputTokens === undefined || input.maxOutputTokens === limit
              ? playgroundIdentity(limit)
              : undefined,
        }
      : {}),
    ...(isEvaluation
      ? {
          evaluationRequestKey: input.evaluationRequestKey,
          evaluationPrinciples: providerInput.evaluationPrinciples,
          // Stable user intent permits recovery after internal strategy changes.
          requestIdentitySha256: sha256(
            JSON.stringify({
              promptId: input.promptId,
              versionId: input.versionId,
              locale: input.locale,
              purpose: input.purpose,
              ...reportSettings,
            }),
          ),
          // Old receipts used the full v1 principles snapshot in their input hash.
          legacyInputSha256: Object.keys(reportSettings).length
            ? undefined
            : inputHash({
                ...providerInput,
                strength: "off",
                maxOutputTokens: 1200,
                evaluationPrinciples: legacyModelEvaluationPrinciples(
                  prompt.taskType,
                  input.locale,
                ) as unknown as ModelGenerateInput["evaluationPrinciples"],
              }),
        }
      : {}),
  });
  if (pending.replay) {
    const r = pending.replay;
    if (isPlayground) return savedPlaygroundResult(r);
    return {
      executionMode: "LIVE",
      purpose: input.purpose,
      executionId: r.id,
      promptId: r.prompt_id,
      versionId: r.prompt_version_id,
      content: r.output_text,
      provider: r.provider,
      requestedModel: r.requested_model,
      resolvedModel: r.resolved_model,
      productVersion: r.product_version,
      strength: r.requested_strength,
      evaluation: {
        ...r.evaluation_report,
        principlesSnapshot: r.evaluation_report.principlesSnapshot ?? r.evaluation_principles,
      },
      usage: {
        promptTokens: r.prompt_tokens,
        completionTokens: r.completion_tokens,
        totalTokens: r.total_tokens,
        ...(r.prompt_cache_hit_tokens != null
          ? { promptCacheHitTokens: r.prompt_cache_hit_tokens }
          : {}),
        ...(r.prompt_cache_miss_tokens != null
          ? { promptCacheMissTokens: r.prompt_cache_miss_tokens }
          : {}),
        ...(r.reasoning_tokens != null ? { reasoningTokens: r.reasoning_tokens } : {}),
      },
      latencyMs: r.latency_ms,
      createdAt: new Date(r.completed_at).toISOString(),
      ...(r.finish_reason ? { finishReason: r.finish_reason } : {}),
    };
  }
  const startedAt = Date.now();
  let receivedResult: ProviderGenerateResult | undefined;
  try {
    await reserveModelQuota({
      executionId: pending.executionId,
      config,
      serializedMessages: dispatch.serializedMessages,
    });

    const result = await generateWithChatModel(config, providerInput, {
      messages: dispatch.messages,
      beforeAttempt: async () => {
        if (input.skillPlanId)
          await withTransaction((c) => loadWorkflowContext(c, input.skillPlanId!));
        await markModelAttempt(pending.executionId);
      },
    });
    receivedResult = result;
    let evaluation: ReturnType<typeof parseModelEvaluation> | undefined;
    if (isEvaluation) {
      try {
        if (result.finishReason && result.finishReason !== "stop")
          throw new Error("Incomplete model report");
        evaluation = parseModelEvaluation(
          result.content,
          version.content,
          prompt.taskType,
          input.locale,
        );
      } catch {
        throw new ModelServiceError(
          "MODEL_EVALUATION_INVALID_REPORT",
          "The provider report was truncated, malformed or contained invalid source evidence. No valid report was published. Returned output and known usage are retained; no automatic retry. Check usage before starting a new report.",
          502,
        );
      }
      const previousRun = (
        await getPool().query(
          "SELECT id FROM model_executions WHERE owner_user_id=$1 AND prompt_id=$2 AND prompt_version_id=$3 AND purpose='PLAYGROUND' AND status='SUCCEEDED' ORDER BY completed_at DESC,id LIMIT 1",
          [workspaceOwnerId(), input.promptId, input.versionId],
        )
      ).rows[0];
      if (previousRun)
        evaluation.layer3 = { status: "EXECUTED_UNGRADED", executionId: previousRun.id };
    }
    const created = await completeSourceModelExecution({
      executionId: pending.executionId,
      purpose: input.purpose,
      promptId: input.promptId,
      promptVersionId: input.versionId,
      result,
      evaluation,
    });
    return {
      executionMode: "LIVE",
      purpose: input.purpose,
      executionId: pending.executionId,
      promptId: input.promptId,
      versionId: input.versionId,
      content: result.content,
      provider: config.provider,
      requestedModel: config.model,
      resolvedModel: result.resolvedModel,
      productVersion: config.productVersion,
      strength: config.strength,
      ...(result.providerRequestId ? { providerRequestId: result.providerRequestId } : {}),
      ...(result.finishReason ? { finishReason: result.finishReason } : {}),
      usage: result.usage,
      latencyMs: result.latencyMs,
      createdAt: created.completedAt,
      ...(evaluation ? { evaluation } : {}),
      ...("optimizationId" in created && created.optimizationId
        ? { optimizationId: created.optimizationId }
        : {}),
      ...("sessionId" in created && created.sessionId ? { sessionId: created.sessionId } : {}),
    };
  } catch (error) {
    const serviceError =
      error instanceof ModelServiceError
        ? error.withExecutionId(pending.executionId)
        : new ModelServiceError(
            "MODEL_SERVICE_FAILED",
            "The live model request failed before it could be saved.",
            503,
            false,
            pending.executionId,
          );
    await failModelExecution(pending.executionId, {
      code: serviceError.code,
      message: serviceError.message,
      latencyMs: Date.now() - startedAt,
      result: receivedResult ?? serviceError.providerResult,
    }).catch(() => undefined);
    throw serviceError;
  }
}

export async function getLiveModelQuota(selection: ModelSelection = {}) {
  const config = readModelConfig(process.env, selection);
  if (config.mode === "DISABLED") {
    throw new ModelServiceError(
      "MODEL_SERVICE_DISABLED",
      "Live model execution is disabled on this server.",
      503,
    );
  }
  return getModelQuotaSummary(config);
}
