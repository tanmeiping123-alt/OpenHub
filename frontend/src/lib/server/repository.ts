import { workspaceOwnerId } from "./identity-context";
import { AccountError } from "./accounts";
import {
  recordAdoptedSources,
  recordExecutionSkillSources,
  loadWorkflowContext,
} from "./skills/skill-context";
import "server-only";
import { randomUUID, createHash } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import {
  createInitialState,
  prompts as fixturePrompts,
  reports as fixtureReports,
  versions as fixtureVersions,
} from "../fixtures";
import type {
  EvaluationReport,
  HistoryItem,
  LiveAdvice,
  Prompt,
  PromptVersion,
  TaskType,
} from "../types";
import { ensureDatabaseReady, getPool, withTransaction } from "./db";
import { assertPromptCapacity } from "./billing/entitlements";
import { parsePromptDescriptor, type PromptDescriptor } from "@/lib/prompt-description";

export type OptimizationRecord = {
  id: string;
  promptId: string;
  sourceVersionId: string;
  proposedContent: string;
  source: string;
  createdAt: string;
};

export type DatabaseSnapshot = {
  prompts: Prompt[];
  versions: PromptVersion[];
  reports: EvaluationReport[];
  history: HistoryItem[];
  libraryPromptIds: string[];
  favorites: string[];
  playgroundRuns: {
    createdAt?: string;
    modelEvidence?: import("@/lib/types").ModelExecutionEvidence;
    id: string;
    versionId: string;
    source?: string;
    executionId?: string;
    outputs: { name: string; text: string; source?: string }[];
  }[];
  liveAdvice: LiveAdvice[];
  optimizationRecords: OptimizationRecord[];
  profileName: string;
};

function dateValue(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapPrompt(row: QueryResultRow): Prompt {
  return {
    id: row.id,
    title: row.title,
    taskType: row.task_type,
    ...(row.descriptor != null ? { descriptor: parsePromptDescriptor(row.descriptor) } : {}),
    currentVersionId: row.current_version_id,
    kind: row.kind,
    description: row.description,
    favorite: row.is_favorite,
  };
}

function mapVersion(row: QueryResultRow): PromptVersion {
  return {
    id: row.id,
    promptId: row.prompt_id,
    number: row.version_number,
    content: row.content,
    title: row.title,
    createdBy: row.created_by,
    source: row.source,
    createdAt: dateValue(row.created_at),
    ...(row.parent_version_id ? { parentVersionId: row.parent_version_id } : {}),
  };
}

function mapReport(row: QueryResultRow): EvaluationReport {
  return {
    id: row.id,
    promptId: row.prompt_id,
    versionId: row.prompt_version_id,
    createdAt: dateValue(row.created_at),
    source: row.source,
    rubricVersion: row.rubric_version,
    layer1: row.layer1,
    layer2: row.layer2,
    layer3: row.layer3,
    ...(row.calibration_snapshot ? { calibration: row.calibration_snapshot } : {}),
  };
}

async function insertFixtures(client: PoolClient) {
  if (workspaceOwnerId() !== "usr_local_demo_01") return;
  await client.query(
    `INSERT INTO app_users (id, identity_key, account_kind)
     VALUES ($1, $2, 'LOCAL_DEMO') ON CONFLICT (id) DO NOTHING`,
    [workspaceOwnerId(), "promptmaster-fixed-local-demo"],
  );
  const profileSeed = await client.query(
    `INSERT INTO user_profiles (user_id, display_name)
     VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING RETURNING user_id`,
    [workspaceOwnerId(), createInitialState().profileName],
  );

  for (const prompt of fixturePrompts) {
    await client.query(
      `INSERT INTO prompts (id, owner_user_id, kind, title, task_type, description, current_version_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (owner_user_id, id) DO NOTHING`,
      [
        prompt.id,
        workspaceOwnerId(),
        prompt.kind,
        prompt.title,
        prompt.taskType,
        prompt.description,
        prompt.currentVersionId,
      ],
    );
  }
  for (const version of fixtureVersions) {
    await client.query(
      `INSERT INTO prompt_versions
         (id, prompt_id, owner_user_id, version_number, title, content, created_by, source, parent_version_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
      [
        version.id,
        version.promptId,
        workspaceOwnerId(),
        version.number,
        version.title,
        version.content,
        version.createdBy,
        version.source,
        version.parentVersionId ?? null,
        version.createdAt,
      ],
    );
  }
  for (const report of fixtureReports) await insertReport(client, report);

  // Seed the starter Library exactly once. Snapshot bootstrap runs repeatedly;
  // reseeding on every read would silently undo a user's remove-from-library action.
  if (profileSeed.rowCount) {
    for (const prompt of fixturePrompts) {
      await client.query(
        "INSERT INTO library_items (owner_user_id, prompt_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [workspaceOwnerId(), prompt.id],
      );
    }
  }
  for (const item of createInitialState().history) {
    await client.query(
      `INSERT INTO history_records (id, owner_user_id, prompt_id, prompt_version_id, source, created_at)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
      [item.id, workspaceOwnerId(), item.promptId, item.versionId, item.source, item.createdAt],
    );
  }
}

function withDemoTransaction<T>(work: (client: PoolClient) => Promise<T>) {
  return withTransaction(async (client) => {
    await insertFixtures(client);
    return work(client);
  });
}

export async function insertReport(client: PoolClient, report: EvaluationReport) {
  await client.query(
    `INSERT INTO evaluation_reports
       (id, owner_user_id, prompt_id, prompt_version_id, source, rubric_version, layer1, layer2, layer3, calibration_snapshot, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11)
     ON CONFLICT (id) DO NOTHING`,
    [
      report.id,
      workspaceOwnerId(),
      report.promptId,
      report.versionId,
      report.source,
      report.rubricVersion,
      JSON.stringify(report.layer1),
      JSON.stringify(report.layer2),
      JSON.stringify(report.layer3),
      report.calibration ? JSON.stringify(report.calibration) : null,
      report.createdAt,
    ],
  );
}

export async function initializeDemoData() {
  await withTransaction(insertFixtures);
}

export async function getSnapshot(client?: PoolClient): Promise<DatabaseSnapshot> {
  await ensureDatabaseReady();
  if (!client) {
    const pool = getPool();
    const connection = await pool.connect();
    try {
      await connection.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const snapshot = await getSnapshot(connection);
      await connection.query("COMMIT");
      return snapshot;
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  }

  // A pg Client owns one connection and must not execute overlapping queries.
  // Keep these reads sequential so the repeatable-read transaction remains
  // consistent without relying on the deprecated client query queue.
  const profile = await client.query("SELECT display_name FROM user_profiles WHERE user_id = $1", [
    workspaceOwnerId(),
  ]);
  const promptRows = await client.query(
    `SELECT p.*, EXISTS (SELECT 1 FROM favorites f WHERE f.owner_user_id = p.owner_user_id AND f.prompt_id = p.id) AS is_favorite
     FROM prompts p WHERE p.owner_user_id = $1 ORDER BY p.created_at DESC, p.id`,
    [workspaceOwnerId()],
  );
  const versionRows = await client.query(
    "SELECT * FROM prompt_versions WHERE owner_user_id = $1 ORDER BY created_at DESC, version_number DESC",
    [workspaceOwnerId()],
  );
  const reportRows = await client.query(
    "SELECT * FROM evaluation_reports WHERE owner_user_id = $1 ORDER BY created_at DESC, id",
    [workspaceOwnerId()],
  );
  const historyRows = await client.query(
    "SELECT * FROM history_records WHERE owner_user_id = $1 ORDER BY created_at DESC, id",
    [workspaceOwnerId()],
  );
  const libraryRows = await client.query(
    "SELECT prompt_id FROM library_items WHERE owner_user_id = $1 ORDER BY saved_at DESC, prompt_id",
    [workspaceOwnerId()],
  );
  const favoriteRows = await client.query(
    "SELECT prompt_id FROM favorites WHERE owner_user_id = $1 ORDER BY created_at DESC, prompt_id",
    [workspaceOwnerId()],
  );
  const optimizationRows = await client.query(
    "SELECT * FROM optimization_records WHERE owner_user_id = $1 ORDER BY created_at DESC, id",
    [workspaceOwnerId()],
  );
  const sessionRows = await client.query(
    "SELECT id, prompt_id, prompt_version_id, source, model_execution_id, created_at FROM playground_sessions WHERE owner_user_id = $1 ORDER BY created_at DESC, id",
    [workspaceOwnerId()],
  );
  const sessionIds = sessionRows.rows.map((row) => row.id as string);
  const outputRows = sessionIds.length
    ? await client.query(
        "SELECT session_id, model_label, output_text, source FROM model_comparison_results WHERE session_id = ANY($1::text[]) ORDER BY session_id, sort_order",
        [sessionIds],
      )
    : { rows: [] as QueryResultRow[] };
  const adviceRows = await client.query(
    `SELECT id, prompt_id, prompt_version_id, output_text, provider, resolved_model,
            product_version, prompt_tokens, completion_tokens, total_tokens,
            prompt_cache_hit_tokens, prompt_cache_miss_tokens, completed_at, requested_strength, reasoning_tokens,
            purpose, evaluation_report, evaluation_principles
     FROM model_executions
     WHERE owner_user_id = $1 AND purpose IN ('EVALUATION_ADVICE','EVALUATION_REPORT') AND status = 'SUCCEEDED'
     ORDER BY completed_at DESC, id`,
    [workspaceOwnerId()],
  );
  const outputsBySession = new Map<string, { name: string; text: string; source?: string }[]>();
  const executionRows = await client.query(
    `SELECT m.id, m.provider, m.requested_model, m.resolved_model, m.requested_strength,
       m.prompt_version_id, m.purpose, m.prompt_tokens, m.completion_tokens, m.total_tokens,
       m.reasoning_tokens, m.prompt_cache_hit_tokens, m.prompt_cache_miss_tokens,
       m.finish_reason, m.latency_ms, m.completed_at,
       a.prompt_version_id AS applied_version_id
     FROM model_executions m LEFT JOIN skill_optimization_applications a
       ON a.optimization_id IN (SELECT o.id FROM optimization_records o WHERE o.model_execution_id=m.id)
       AND a.owner_user_id=m.owner_user_id
     WHERE m.owner_user_id=$1 AND m.status='SUCCEEDED'`,
    [workspaceOwnerId()],
  );
  const evidenceByExecution = new Map<string, import("@/lib/types").ModelExecutionEvidence>();
  const evidenceByVersion = new Map<string, import("@/lib/types").ModelExecutionEvidence>();
  for (const e of executionRows.rows) {
    const evidence = {
      executionId: e.id,
      provider: e.provider,
      requestedModel: e.requested_model,
      resolvedModel: e.resolved_model,
      ...(e.finish_reason ? { finishReason: e.finish_reason } : {}),
      ...(e.latency_ms != null ? { latencyMs: e.latency_ms } : {}),
      ...(e.completed_at ? { createdAt: dateValue(e.completed_at) } : {}),
      ...(e.requested_strength ? { strength: e.requested_strength } : {}),
      usage: {
        promptTokens: e.prompt_tokens,
        completionTokens: e.completion_tokens,
        totalTokens: e.total_tokens,
        ...(e.reasoning_tokens != null ? { reasoningTokens: e.reasoning_tokens } : {}),
        ...(e.prompt_cache_hit_tokens != null
          ? { promptCacheHitTokens: e.prompt_cache_hit_tokens }
          : {}),
        ...(e.prompt_cache_miss_tokens != null
          ? { promptCacheMissTokens: e.prompt_cache_miss_tokens }
          : {}),
      },
    };
    evidenceByExecution.set(e.id, evidence);
    if (e.purpose === "PROMPT_GENERATION") evidenceByVersion.set(e.prompt_version_id, evidence);
    if (e.applied_version_id) evidenceByVersion.set(e.applied_version_id, evidence);
  }
  for (const output of outputRows.rows) {
    const outputs = outputsBySession.get(output.session_id) ?? [];
    outputs.push({ name: output.model_label, text: output.output_text, source: output.source });
    outputsBySession.set(output.session_id, outputs);
  }

  return {
    prompts: promptRows.rows.map(mapPrompt),
    versions: versionRows.rows.map((row) => ({
      ...mapVersion(row),
      ...(evidenceByVersion.has(row.id) ? { modelEvidence: evidenceByVersion.get(row.id) } : {}),
    })),
    reports: reportRows.rows.map(mapReport),
    history: historyRows.rows.map((row) => ({
      id: row.id,
      promptId: row.prompt_id,
      versionId: row.prompt_version_id,
      source: row.source,
      createdAt: dateValue(row.created_at),
    })),
    libraryPromptIds: libraryRows.rows.map((row) => row.prompt_id),
    favorites: favoriteRows.rows.map((row) => row.prompt_id),
    optimizationRecords: optimizationRows.rows.map((row) => ({
      id: row.id,
      promptId: row.prompt_id,
      sourceVersionId: row.source_prompt_version_id,
      proposedContent: row.proposed_content,
      source: row.source,
      createdAt: dateValue(row.created_at),
    })),
    playgroundRuns: sessionRows.rows.map((row) => ({
      createdAt: dateValue(row.created_at),
      ...(evidenceByExecution.has(row.model_execution_id)
        ? { modelEvidence: evidenceByExecution.get(row.model_execution_id) }
        : {}),
      id: row.id,
      versionId: row.prompt_version_id,
      source: row.source,
      ...(row.model_execution_id ? { executionId: row.model_execution_id } : {}),
      outputs: outputsBySession.get(row.id) ?? [],
    })),
    liveAdvice: adviceRows.rows.map((row) => ({
      ...(row.purpose === "EVALUATION_REPORT"
        ? {
            kind: "EVALUATION_REPORT" as const,
            evaluation: row.evaluation_report
              ? {
                  ...row.evaluation_report,
                  ...(row.evaluation_report.principlesSnapshot || !row.evaluation_principles
                    ? {}
                    : { principlesSnapshot: row.evaluation_principles }),
                }
              : row.evaluation_report,
          }
        : {}),
      id: `adv_${row.id}`,
      executionId: row.id,
      promptId: row.prompt_id,
      versionId: row.prompt_version_id,
      content: row.output_text,
      provider: row.provider,
      ...(row.requested_strength ? { strength: row.requested_strength } : {}),
      model: row.resolved_model,
      productVersion: row.product_version,
      usage: {
        promptTokens: row.prompt_tokens,
        completionTokens: row.completion_tokens,
        totalTokens: row.total_tokens,
        ...(row.reasoning_tokens != null ? { reasoningTokens: row.reasoning_tokens } : {}),
        ...(row.prompt_cache_hit_tokens !== null
          ? { promptCacheHitTokens: row.prompt_cache_hit_tokens }
          : {}),
        ...(row.prompt_cache_miss_tokens !== null
          ? { promptCacheMissTokens: row.prompt_cache_miss_tokens }
          : {}),
      },
      createdAt: dateValue(row.completed_at),
    })),
    profileName: profile.rows[0]?.display_name ?? createInitialState().profileName,
  };
}

export async function bootstrap() {
  await initializeDemoData();
  return getSnapshot();
}

function newId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

export async function createPrompt(input: {
  title: string;
  taskType: TaskType;
  content: string;
  description?: string;
  manualDraft?: boolean;
  requestKey?: string;
  adoptedUseEventIds?: string[];
  descriptor?: PromptDescriptor;
}) {
  return withDemoTransaction(async (client) => {
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          title: input.title,
          taskType: input.taskType,
          content: input.content,
          description: input.description ?? "",
          manualDraft: input.manualDraft ?? false,
          adoptedUseEventIds: input.adoptedUseEventIds ?? [],
          ...(input.descriptor ? { descriptor: input.descriptor } : {}),
        }),
      )
      .digest("hex");
    if (input.requestKey) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `prompt-create:${workspaceOwnerId()}:${input.requestKey}`,
      ]);
      const previous = (
        await client.query(
          'SELECT payload_sha256,prompt_id AS "promptId",version_id AS "versionId",created_at AS "createdAt" FROM prompt_creation_requests WHERE owner_user_id=$1 AND request_key=$2',
          [workspaceOwnerId(), input.requestKey],
        )
      ).rows[0];
      if (previous) {
        if (previous.payload_sha256 !== fingerprint)
          throw Object.assign(new Error("Creation request changed"), {
            code: "IDEMPOTENCY_CONFLICT",
          });
        return {
          promptId: previous.promptId,
          versionId: previous.versionId,
          createdAt: previous.createdAt,
        };
      }
    }
    await assertPromptCapacity(client, workspaceOwnerId());
    const promptId = newId("prm");
    const versionId = newId("ver");
    const createdAt = new Date().toISOString();
    await client.query(
      `INSERT INTO prompts (id, owner_user_id, kind, title, task_type, description, current_version_id)
       VALUES ($1, $2, 'PERSONAL_PROMPT', $3, $4, $5, $6)`,
      [
        promptId,
        workspaceOwnerId(),
        input.title,
        input.taskType,
        input.description ?? "",
        versionId,
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
        input.content,
        createdAt,
        workspaceOwnerId(),
        input.manualDraft ? "MANUAL_DRAFT" : "MOCK_SIMULATED",
      ],
    );
    await client.query(
      `INSERT INTO history_records (id, owner_user_id, prompt_id, prompt_version_id, source, created_at)
       VALUES ($1, $2, $3, $4, $6, $5)`,
      [
        newId("his"),
        workspaceOwnerId(),
        promptId,
        versionId,
        createdAt,
        input.manualDraft ? "MANUAL_DRAFT" : "MOCK_SIMULATED",
      ],
    );
    await recordAdoptedSources(client, versionId, input.adoptedUseEventIds);
    if (input.descriptor)
      await client.query("UPDATE prompts SET descriptor=$1 WHERE id=$2 AND owner_user_id=$3", [
        JSON.stringify(parsePromptDescriptor(input.descriptor)),
        promptId,
        workspaceOwnerId(),
      ]);
    if (input.requestKey)
      await client.query(
        "INSERT INTO prompt_creation_requests(owner_user_id,request_key,payload_sha256,prompt_id,version_id,created_at) VALUES($1,$2,$3,$4,$5,$6)",
        [workspaceOwnerId(), input.requestKey, fingerprint, promptId, versionId, createdAt],
      );
    return { promptId, versionId, createdAt };
  });
}

export async function createPromptVersion(input: {
  descriptor?: PromptDescriptor;
  promptId: string;
  content: string;
  title?: string;
  baseVersionId: string;
  parentVersionId?: string;
  source: string;
  adoptedUseEventIds?: string[];
  optimizationId?: string;
}) {
  const descriptor =
    input.descriptor === undefined ? undefined : parsePromptDescriptor(input.descriptor);
  return withDemoTransaction(async (client) => {
    const promptResult = await client.query(
      "SELECT id, title, current_version_id, descriptor FROM prompts WHERE id = $1 AND owner_user_id = $2 FOR UPDATE",
      [input.promptId, workspaceOwnerId()],
    );
    const prompt = promptResult.rows[0];
    if (!prompt) return null;
    let skillExecutionId: string | undefined;
    if (input.optimizationId) {
      const proposal = (
        await client.query(
          "SELECT model_execution_id,proposed_content,source_prompt_version_id FROM optimization_records WHERE id=$1 AND owner_user_id=$2 AND prompt_id=$3",
          [input.optimizationId, workspaceOwnerId(), input.promptId],
        )
      ).rows[0];
      if (
        !proposal ||
        proposal.proposed_content !== input.content ||
        proposal.source_prompt_version_id !== input.baseVersionId
      )
        throw new AccountError("OPTIMIZATION_PROOF_INVALID", 409);
      const applied = (
        await client.query(
          `SELECT v.id AS "versionId",v.version_number AS number,v.created_at AS "createdAt" FROM skill_optimization_applications a JOIN prompt_versions v ON v.id=a.prompt_version_id AND v.owner_user_id=a.owner_user_id WHERE a.optimization_id=$1 AND a.owner_user_id=$2 AND v.prompt_id=$3`,
          [input.optimizationId, workspaceOwnerId(), input.promptId],
        )
      ).rows[0];
      if (applied) return { promptId: input.promptId, ...applied };
      const unchangedReceipt = (
        await client.query(
          `SELECT v.id AS "versionId",v.version_number AS number,v.created_at AS "createdAt" FROM optimization_no_change_receipts a JOIN prompt_versions v ON v.id=a.prompt_version_id AND v.owner_user_id=a.owner_user_id WHERE a.optimization_id=$1 AND a.owner_user_id=$2 AND v.prompt_id=$3`,
          [input.optimizationId, workspaceOwnerId(), input.promptId],
        )
      ).rows[0];
      if (unchangedReceipt)
        return { promptId: input.promptId, ...unchangedReceipt, unchanged: true };
      skillExecutionId = proposal.model_execution_id;
      if (skillExecutionId) {
        const context = (
          await client.query(
            "SELECT plan_id FROM skill_model_contexts WHERE execution_id=$1 AND owner_user_id=$2",
            [skillExecutionId, workspaceOwnerId()],
          )
        ).rows[0];
        if (context) await loadWorkflowContext(client, context.plan_id);
      }
    }
    if (prompt.current_version_id !== input.baseVersionId) {
      throw Object.assign(new Error("Prompt changed since this edit began."), {
        code: "VERSION_CONFLICT",
      });
    }

    const sourceResult = await client.query(
      "SELECT id FROM prompt_versions WHERE id = $1 AND prompt_id = $2 AND owner_user_id = $3",
      [input.parentVersionId ?? input.baseVersionId, input.promptId, workspaceOwnerId()],
    );
    if (!sourceResult.rowCount) return null;
    if (
      input.optimizationId &&
      (!input.title || input.title.trim() === prompt.title) &&
      (descriptor === undefined || JSON.stringify(descriptor) === JSON.stringify(prompt.descriptor))
    ) {
      const current = (
        await client.query(
          `SELECT id AS "versionId",version_number AS number,created_at AS "createdAt",content FROM prompt_versions WHERE id=$1 AND prompt_id=$2 AND owner_user_id=$3`,
          [input.baseVersionId, input.promptId, workspaceOwnerId()],
        )
      ).rows[0];
      if (current?.content === input.content) {
        await client.query(
          "INSERT INTO optimization_no_change_receipts(optimization_id,owner_user_id,prompt_version_id) VALUES($1,$2,$3)",
          [input.optimizationId, workspaceOwnerId(), input.baseVersionId],
        );
        return {
          promptId: input.promptId,
          versionId: current.versionId,
          number: current.number,
          createdAt: current.createdAt,
          unchanged: true,
        };
      }
    }

    const numberResult = await client.query(
      "SELECT COALESCE(MAX(version_number), 0) + 1 AS next_number FROM prompt_versions WHERE prompt_id = $1 AND owner_user_id = $2",
      [input.promptId, workspaceOwnerId()],
    );
    const versionId = newId("ver");
    const createdAt = new Date().toISOString();
    const title = input.title?.trim() || prompt.title;
    await client.query(
      `INSERT INTO prompt_versions
         (id, prompt_id, owner_user_id, version_number, title, content, created_by, source, parent_version_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'local-demo', $7, $8, $9)`,
      [
        versionId,
        input.promptId,
        workspaceOwnerId(),
        numberResult.rows[0].next_number,
        title,
        input.content,
        input.source,
        input.parentVersionId ?? input.baseVersionId,
        createdAt,
      ],
    );
    await client.query(
      "UPDATE prompts SET current_version_id = $1, title = $2, updated_at = $3, descriptor = COALESCE($6::jsonb, descriptor) WHERE id = $4 AND owner_user_id = $5",
      [
        versionId,
        title,
        createdAt,
        input.promptId,
        workspaceOwnerId(),
        descriptor === undefined ? null : JSON.stringify(descriptor),
      ],
    );
    await client.query(
      `INSERT INTO history_records (id, owner_user_id, prompt_id, prompt_version_id, source, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [newId("his"), workspaceOwnerId(), input.promptId, versionId, input.source, createdAt],
    );
    await recordAdoptedSources(client, versionId, input.adoptedUseEventIds);
    if (skillExecutionId) await recordExecutionSkillSources(client, skillExecutionId, versionId);
    if (input.optimizationId)
      await client.query(
        "INSERT INTO skill_optimization_applications(optimization_id,owner_user_id,prompt_version_id) VALUES($1,$2,$3)",
        [input.optimizationId, workspaceOwnerId(), versionId],
      );
    return {
      promptId: input.promptId,
      versionId,
      number: Number(numberResult.rows[0].next_number),
      createdAt,
    };
  });
}

export async function saveEvaluationReport(report: EvaluationReport) {
  return withDemoTransaction(async (client) => {
    const version = await client.query(
      "SELECT 1 FROM prompt_versions WHERE id = $1 AND prompt_id = $2 AND owner_user_id = $3",
      [report.versionId, report.promptId, workspaceOwnerId()],
    );
    if (!version.rowCount) return false;
    await insertReport(client, report);
    return true;
  });
}

export async function getPromptTaskType(promptId: string) {
  await ensureDatabaseReady();
  const result = await getPool().query(
    "SELECT task_type FROM prompts WHERE id = $1 AND owner_user_id = $2",
    [promptId, workspaceOwnerId()],
  );
  return result.rows[0]?.task_type as TaskType | undefined;
}

export async function getPromptSummary(promptId: string) {
  await ensureDatabaseReady();
  const result = await getPool().query(
    "SELECT id, task_type FROM prompts WHERE id = $1 AND owner_user_id = $2",
    [promptId, workspaceOwnerId()],
  );
  return result.rows[0] as { id: string; task_type: TaskType } | undefined;
}

export async function getPromptForEvaluation(promptId: string) {
  await ensureDatabaseReady();
  const result = await getPool().query(
    `SELECT p.*,
            EXISTS (
              SELECT 1 FROM favorites f
              WHERE f.owner_user_id = p.owner_user_id AND f.prompt_id = p.id
            ) AS is_favorite
     FROM prompts p
     WHERE p.id = $1 AND p.owner_user_id = $2`,
    [promptId, workspaceOwnerId()],
  );
  return result.rows[0] ? mapPrompt(result.rows[0]) : undefined;
}

export async function getPromptVersion(promptId: string, versionId: string) {
  await ensureDatabaseReady();
  const result = await getPool().query(
    `SELECT * FROM prompt_versions
     WHERE id = $1 AND prompt_id = $2 AND owner_user_id = $3`,
    [versionId, promptId, workspaceOwnerId()],
  );
  return result.rows[0] ? mapVersion(result.rows[0]) : undefined;
}

export async function saveOptimization(input: {
  promptId: string;
  sourceVersionId: string;
  proposedContent: string;
}) {
  return withDemoTransaction(async (client) => {
    const source = await client.query(
      "SELECT 1 FROM prompt_versions WHERE id = $1 AND prompt_id = $2 AND owner_user_id = $3",
      [input.sourceVersionId, input.promptId, workspaceOwnerId()],
    );
    if (!source.rowCount) return false;
    await client.query(
      `INSERT INTO optimization_records
         (id, owner_user_id, prompt_id, source_prompt_version_id, proposed_content, source)
       VALUES ($1, $2, $3, $4, $5, 'MOCK_SIMULATED')`,
      [
        newId("opt"),
        workspaceOwnerId(),
        input.promptId,
        input.sourceVersionId,
        input.proposedContent,
      ],
    );
    return true;
  });
}

export async function savePlaygroundRun(input: {
  promptId: string;
  versionId: string;
  outputs: { name: string; text: string }[];
}) {
  return withDemoTransaction(async (client) => {
    const source = await client.query(
      "SELECT 1 FROM prompt_versions WHERE id = $1 AND prompt_id = $2 AND owner_user_id = $3",
      [input.versionId, input.promptId, workspaceOwnerId()],
    );
    if (!source.rowCount) return false;
    const sessionId = newId("pls");
    await client.query(
      `INSERT INTO playground_sessions (id, owner_user_id, prompt_id, prompt_version_id, source)
       VALUES ($1, $2, $3, $4, 'MOCK_SIMULATED')`,
      [sessionId, workspaceOwnerId(), input.promptId, input.versionId],
    );
    for (const [sortOrder, output] of input.outputs.entries()) {
      await client.query(
        `INSERT INTO model_comparison_results (session_id, sort_order, model_label, output_text, source)
         VALUES ($1, $2, $3, $4, 'MOCK_SIMULATED')`,
        [sessionId, sortOrder, output.name, output.text],
      );
    }
    return { sessionId };
  });
}

export async function setLibraryItem(promptId: string, saved: boolean) {
  return withDemoTransaction(async (client) => {
    const prompt = await client.query(
      "SELECT 1 FROM prompts WHERE id = $1 AND owner_user_id = $2",
      [promptId, workspaceOwnerId()],
    );
    if (!prompt.rowCount) return false;
    if (saved) {
      await client.query(
        "INSERT INTO library_items (owner_user_id, prompt_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [workspaceOwnerId(), promptId],
      );
    } else {
      await client.query("DELETE FROM library_items WHERE owner_user_id = $1 AND prompt_id = $2", [
        workspaceOwnerId(),
        promptId,
      ]);
    }
    return true;
  });
}

export async function setFavorite(promptId: string, favorite: boolean) {
  return withDemoTransaction(async (client) => {
    const prompt = await client.query(
      "SELECT 1 FROM prompts WHERE id = $1 AND owner_user_id = $2",
      [promptId, workspaceOwnerId()],
    );
    if (!prompt.rowCount) return false;
    if (favorite) {
      await client.query(
        "INSERT INTO favorites (owner_user_id, prompt_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [workspaceOwnerId(), promptId],
      );
    } else {
      await client.query("DELETE FROM favorites WHERE owner_user_id = $1 AND prompt_id = $2", [
        workspaceOwnerId(),
        promptId,
      ]);
    }
    return true;
  });
}

export async function updateProfileName(name: string) {
  await withDemoTransaction((client) =>
    client
      .query("UPDATE user_profiles SET display_name = $1, updated_at = now() WHERE user_id = $2", [
        name,
        workspaceOwnerId(),
      ])
      .then(() => undefined),
  );
}
