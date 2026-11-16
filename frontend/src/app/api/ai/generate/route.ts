import { withIdentity } from "@/lib/server/authenticated-route";
import { validModelSelection, modelSelection } from "@/lib/model-catalog";
import { taskTypes } from "@/lib/fixtures";
import { boundedText, guardLocalDemoApi, isRecord } from "@/lib/server/api";
import { toPublicModelError } from "@/lib/server/model/model-errors";
import { generateLivePrompt } from "@/lib/server/model/model-service";
import type { Locale, TaskType } from "@/lib/types";
import { parsePromptDescriptor } from "@/lib/prompt-description";

export const runtime = "nodejs";

async function handlePOST(request: Request) {
  const blocked = guardLocalDemoApi(request, true);
  if (blocked) return blocked;
  try {
    const body: unknown = await request.json();
    if (
      !isRecord(body) ||
      !validModelSelection(body) ||
      !boundedText(body.goal, 8000) ||
      (body.taskType !== undefined && !taskTypes.includes(body.taskType as TaskType)) ||
      (body.locale !== "en" && body.locale !== "zh-CN")
    ) {
      return Response.json({ error: "INVALID_MODEL_GENERATION_INPUT" }, { status: 400 });
    }
    let descriptor;
    try {
      descriptor =
        body.descriptor === undefined ? undefined : parsePromptDescriptor(body.descriptor);
    } catch {
      return Response.json({ error: "INVALID_MODEL_GENERATION_INPUT" }, { status: 400 });
    }
    const result = await generateLivePrompt({
      goal: body.goal.trim(),
      taskType: (body.taskType ?? "General") as TaskType,
      ...(descriptor ? { descriptor } : {}),
      locale: body.locale as Locale,
      signal: request.signal,
      ...modelSelection(body),
    });
    return Response.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const detail = toPublicModelError(error);
    console.error("PromptMaster live generation failed", {
      code: detail.code,
      executionId: detail.executionId,
    });
    return Response.json(
      {
        error: detail.code,
        message: detail.message,
        ...(detail.executionId ? { executionId: detail.executionId } : {}),
      },
      { status: detail.status, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export const POST = withIdentity(handlePOST);
