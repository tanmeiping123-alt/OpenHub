import { withIdentity, boundedJson } from "@/lib/server/authenticated-route";
import { AccountError } from "@/lib/server/accounts";
import { isRecord, boundedText } from "@/lib/server/api";
import { taskTypes } from "@/lib/fixtures";
import { validModelSelection } from "@/lib/model-catalog";
import { parseEvaluationHandoff } from "@/lib/evaluation-handoff";
import { parsePromptDescriptor } from "@/lib/prompt-description";
import {
  createSkillPlan,
  runSkillPlan,
  skillWorkflowStatus,
} from "@/lib/server/skills/skill-workflow-service";
export const runtime = "nodejs";
export const GET = withIdentity(async (request: Request) => {
  const params = new URL(request.url).searchParams,
    key = params.get("requestKey");
  if ([...params.keys()].join(",") !== "requestKey" || !key || !/^[a-zA-Z0-9._-]{1,120}$/.test(key))
    throw new AccountError("INVALID_INPUT");
  const result = await skillWorkflowStatus(key);
  return Response.json(result ?? { status: "NOT_FOUND" });
}, true);
export const POST = withIdentity(async (request: Request) => {
  const b = await boundedJson(request, 16000);
  if (!isRecord(b) || new URL(request.url).search) throw new AccountError("INVALID_INPUT");
  if (b.action === "plan") {
    if (
      Object.keys(b).some(
        (k) =>
          ![
            "action",
            "goal",
            "taskType",
            "locale",
            "matchingMode",
            "selectedVersionIds",
            "responsibilities",
            "manualOverride",
            "deliveryPreference",
            "descriptor",
            "source",
            "evaluationHandoff",
          ].includes(k),
      ) ||
      (b.source === undefined
        ? !boundedText(b.goal, 10000)
        : b.goal !== undefined ||
          !isRecord(b.source) ||
          Object.keys(b.source).sort().join(",") !== "promptId,versionId" ||
          !boundedText(b.source.promptId, 120) ||
          !boundedText(b.source.versionId, 120)) ||
      (b.manualOverride !== undefined && typeof b.manualOverride !== "boolean") ||
      (b.taskType !== undefined && !taskTypes.includes(b.taskType as never)) ||
      (b.deliveryPreference !== undefined &&
        !["AUTO", "SINGLE_PROMPT", "PROMPT_PACKAGE"].includes(String(b.deliveryPreference))) ||
      !["en", "zh-CN"].includes(String(b.locale)) ||
      !["AUTO", "HYBRID", "MANUAL"].includes(String(b.matchingMode)) ||
      !Array.isArray(b.selectedVersionIds) ||
      b.selectedVersionIds.length > 4 ||
      !b.selectedVersionIds.every((v) => typeof v === "string" && /^skv_[a-f0-9-]{36}$/.test(v)) ||
      (b.responsibilities !== undefined &&
        (!isRecord(b.responsibilities) ||
          Object.entries(b.responsibilities).some(
            ([k, v]) =>
              !(b.selectedVersionIds as string[]).includes(k) ||
              typeof v !== "string" ||
              v.length > 500,
          )))
    )
      throw new AccountError("INVALID_INPUT");
    let descriptor;
    let evaluationHandoff;
    try {
      if (b.evaluationHandoff !== undefined) {
        if (!b.source) throw Error("INVALID_INPUT");
        evaluationHandoff = parseEvaluationHandoff(b.evaluationHandoff);
      }
      descriptor = b.descriptor === undefined ? undefined : parsePromptDescriptor(b.descriptor);
    } catch {
      throw new AccountError("INVALID_INPUT");
    }
    return Response.json(
      await createSkillPlan({
        ...b,
        descriptor,
        ...(evaluationHandoff ? { evaluationHandoff } : {}),
        taskType: b.taskType ?? "General",
      } as unknown as Parameters<typeof createSkillPlan>[0]),
    );
  }
  if (b.action === "run") {
    const key = request.headers.get("idempotency-key");
    if (
      !key ||
      !/^[a-zA-Z0-9._-]{1,120}$/.test(key) ||
      Object.keys(b).some(
        (k) =>
          ![
            "action",
            "planId",
            "purpose",
            "promptId",
            "versionId",
            "modelKey",
            "strength",
            "maxOutputTokens",
          ].includes(k),
      ) ||
      !boundedText(b.planId, 120) ||
      !validModelSelection(b) ||
      !["PROMPT_GENERATION", "OPTIMIZATION"].includes(String(b.purpose)) ||
      (b.purpose === "OPTIMIZATION" &&
        (!boundedText(b.promptId, 120) || !boundedText(b.versionId, 120)))
    )
      throw new AccountError("INVALID_INPUT");
    return Response.json(
      await runSkillPlan(b as unknown as Parameters<typeof runSkillPlan>[0], key, request.signal),
    );
  }
  throw new AccountError("INVALID_INPUT");
}, true);
