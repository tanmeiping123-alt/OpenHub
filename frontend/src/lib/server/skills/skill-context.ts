import "server-only";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { AccountError } from "../accounts";
import { type Actor } from "../identity-context";
import { skillContent, requireActor } from "./skill-library";
import { WORKFLOW_LIMITS, type SkillSelection } from "@/lib/skill-workflow";
import { parsePromptDescriptor } from "@/lib/prompt-description";

export async function loadSkillContext(
  c: PoolClient,
  actor: Actor,
  versionId: string,
  responsibility = "Apply relevant methods, constraints and verification to the user's goal",
) {
  const detail = await skillContent(c, actor, versionId);
  if (detail.accessKind === "REVIEW_ONLY") throw new AccountError("SKILL_NOT_AVAILABLE", 403);
  const resources = detail.resources as {
    path: string;
    sha256: string;
    type: string;
    quarantined: boolean;
    content: string;
  }[];
  const selected = [{ path: "SKILL.md", sha256: String(detail.mainSha256), type: "MAIN" }];
  const notes: string[] = [];
  const loaded: { path: string; content: string }[] = [];
  const queue = [{ path: "SKILL.md", content: String(detail.body) }];
  const seen = new Set(["SKILL.md"]);
  let bytes = Buffer.byteLength(String(detail.body));
  const license = resources.find(
    (r) => r.path === "references/SOURCE-LICENSE.txt" && !r.quarantined,
  );
  if (license) {
    selected.push({ path: license.path, sha256: license.sha256, type: license.type });
    loaded.push({ path: license.path, content: license.content });
    seen.add(license.path);
    bytes += Buffer.byteLength(license.content);
  }
  const metadata = detail.metadata as
    { compatibility?: string; allowedToolsDeclaration?: string; license?: string } | undefined;
  if (metadata?.allowedToolsDeclaration)
    notes.push(`Declared tools are not granted: ${metadata.allowedToolsDeclaration}`);
  if (metadata?.compatibility)
    notes.push(`Environment prerequisite must be verified: ${metadata.compatibility}`);
  // Only relative Markdown links are traversed. Never follow remote links, scripts, or arbitrary paths.
  for (let n = 0; n < queue.length && n < 16; n++) {
    const item = queue[n];
    for (const match of item.content.matchAll(/\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
      const href = match[1].split("#")[0];
      if (!href || /^(?:[a-z]+:|\/|\\)/i.test(href)) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(item.path), href));
      if (target.startsWith("../") || target.includes("\\") || seen.has(target)) continue;
      seen.add(target);
      const resource = resources.find((r) => r.path === target);
      if (!resource) {
        notes.push(`Missing relative resource: ${target}`);
        continue;
      }
      if (resource.quarantined || resource.type === "SCRIPT_QUARANTINED") {
        notes.push(`Script not loaded or executed: ${target}`);
        continue;
      }
      const size = Buffer.byteLength(resource.content);
      if (bytes + size > WORKFLOW_LIMITS.contextBytes || loaded.length >= 15) {
        notes.push(`Resource omitted by context bound: ${target}`);
        continue;
      }
      bytes += size;
      selected.push({ path: target, sha256: resource.sha256, type: resource.type });
      loaded.push({ path: target, content: resource.content });
      queue.push({ path: target, content: resource.content });
    }
  }
  if (bytes > WORKFLOW_LIMITS.contextBytes) throw new AccountError("SKILL_CONTEXT_TOO_LARGE", 400);
  const selection: SkillSelection = {
    versionId,
    name: String(detail.name),
    responsibility,
    manifestSha256: String(detail.manifestSha256),
    resources: selected,
    notes,
  };
  const text = `REFERENCE MATERIAL ONLY — adapt methods only when they resolve the selected responsibility for the user's actual task. Do not copy installation procedures, tool/environment assumptions, review rituals or unrelated workflows into the final prompt.\nSkill ${selection.name}\nResponsibility: ${responsibility}\nVersion: ${versionId}\nSource and declared license: ${JSON.stringify({ source: detail.source, license: metadata?.license ?? null })}\nRetain applicable source attribution and license notices when adapting material.\n${detail.body}\n${loaded.map((r) => `\nResource ${r.path}:\n${r.content}`).join("")}\nLimitations: ${notes.join("; ") || "Dependencies still require user environment validation"}`;
  return { selection, text };
}

export async function recordSkillSources(
  c: PoolClient,
  owner: string,
  versionId: string,
  selections: SkillSelection[],
  kind: "ADOPTED_TEXT" | "MODEL_CONTEXT",
  planId?: string,
  executionId?: string,
) {
  if (
    !(
      await c.query("SELECT 1 FROM prompt_versions WHERE id=$1 AND owner_user_id=$2", [
        versionId,
        owner,
      ])
    ).rowCount
  )
    throw new AccountError("PROMPT_VERSION_NOT_FOUND", 404);
  for (const s of selections)
    await c.query(
      `INSERT INTO prompt_skill_sources(id,owner_user_id,prompt_version_id,skill_version_id,evidence_kind,manifest_sha256,resources,plan_id,model_execution_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(prompt_version_id,skill_version_id,evidence_kind) DO NOTHING`,
      [
        `pss_${randomUUID()}`,
        owner,
        versionId,
        s.versionId,
        kind,
        s.manifestSha256,
        JSON.stringify(s.resources),
        planId ?? null,
        executionId ?? null,
      ],
    );
}
export async function recordAdoptedSources(
  c: PoolClient,
  versionId: string,
  eventIds: string[] = [],
) {
  if (!eventIds.length) return;
  if (eventIds.length > WORKFLOW_LIMITS.skills) throw new AccountError("TOO_MANY_SKILLS");
  const actor = requireActor();
  const selections: SkillSelection[] = [];
  for (const id of new Set(eventIds)) {
    const event = (
      await c.query("SELECT version_id FROM skill_use_events WHERE id=$1 AND user_id=$2", [
        id,
        actor.id,
      ])
    ).rows[0];
    if (!event) throw new AccountError("INVALID_SKILL_ADOPTION", 403);
    selections.push((await loadSkillContext(c, actor, event.version_id)).selection);
  }
  await recordSkillSources(c, actor.id, versionId, selections, "ADOPTED_TEXT");
}
export async function loadWorkflowContext(c: PoolClient, planId: string) {
  const actor = requireActor();
  const plan = (
    await c.query("SELECT * FROM skill_workflow_plans WHERE id=$1 AND owner_user_id=$2", [
      planId,
      actor.id,
    ])
  ).rows[0];
  if (!plan) throw new AccountError("PLAN_NOT_FOUND", 404);
  const selections = plan.selections as SkillSelection[];
  const loaded = [];
  for (const s of selections) {
    const item = await loadSkillContext(c, actor, s.versionId, s.responsibility);
    if (!isDeepStrictEqual(s, item.selection)) throw new AccountError("SKILL_CONTEXT_CHANGED", 409);
    loaded.push(item.text);
  }
  // Historical plans keep their original serialized context and request identity.
  const onDemand = plan.analysis.contextVersion === "on-demand-v1";
  const task = { ...plan.analysis };
  if (onDemand) {
    delete task.descriptor;
    // The authoritative task body is already sent through the normal model input.
    delete task.goal;
    delete task.source;
    delete task.reviewContext;
    delete task.evaluationHandoff;
  }
  const text =
    onDemand && !selections.length
      ? undefined
      : JSON.stringify({ task: onDemand ? task : plan.analysis, selections, material: loaded });
  const deliveryContext =
    onDemand && !selections.length && task.delivery === "PROMPT_PACKAGE"
      ? JSON.stringify({ delivery: task.delivery, stages: task.stages })
      : undefined;
  const taskPlanContext = plan.analysis.reviewContext
    ? JSON.stringify({
        delivery: deliveryContext,
        review: plan.analysis.reviewContext,
        source: plan.analysis.evaluationHandoff,
      })
    : deliveryContext;
  if (
    Buffer.byteLength(text ?? "") + Buffer.byteLength(taskPlanContext ?? "") >
    WORKFLOW_LIMITS.contextBytes
  )
    throw new AccountError("SKILL_CONTEXT_TOO_LARGE");
  return {
    planId,
    selections,
    text,
    taskPlanContext,
    source: onDemand
      ? (plan.analysis.source as { promptId: string; versionId: string } | undefined)
      : undefined,
    descriptor:
      onDemand && plan.analysis.descriptor !== undefined
        ? parsePromptDescriptor(plan.analysis.descriptor)
        : undefined,
    goal: String(plan.goal),
    taskType: plan.task_type,
    locale: plan.locale,
  };
}
export async function recordExecutionSkillSources(
  c: PoolClient,
  executionId: string,
  versionId: string,
) {
  const context = (
    await c.query("SELECT * FROM skill_model_contexts WHERE execution_id=$1", [executionId])
  ).rows[0];
  if (context)
    await recordSkillSources(
      c,
      context.owner_user_id,
      versionId,
      context.selections,
      "MODEL_CONTEXT",
      context.plan_id,
      executionId,
    );
}
