import { withIdentity } from "@/lib/server/authenticated-route";
import { taskTypes } from "@/lib/fixtures";
import { MAX_PROMPT_CONTENT_CHARACTERS } from "@/lib/prompt-content";
import {
  apiError,
  boundedText,
  guardLocalDemoApi,
  isRecord,
  validAdoptionIds,
} from "@/lib/server/api";
import { createPrompt } from "@/lib/server/services/prompt-service";
import { parsePromptDescriptor } from "@/lib/prompt-description";

export const runtime = "nodejs";

async function handlePOST(request: Request) {
  const blocked = guardLocalDemoApi(request, true);
  if (blocked) return blocked;
  try {
    const body: unknown = await request.json();
    const requestKey = request.headers.get("idempotency-key") ?? undefined;
    if (requestKey && !/^[a-zA-Z0-9._-]{1,120}$/.test(requestKey))
      return Response.json({ error: "INVALID_IDEMPOTENCY_KEY" }, { status: 400 });
    if (
      !isRecord(body) ||
      !validAdoptionIds(body.adoptedUseEventIds) ||
      !boundedText(body.title, 240) ||
      !boundedText(body.content, MAX_PROMPT_CONTENT_CHARACTERS) ||
      (body.description !== undefined && typeof body.description !== "string") ||
      (body.manualDraft !== undefined && typeof body.manualDraft !== "boolean") ||
      (body.taskType !== undefined &&
        !taskTypes.includes(body.taskType as (typeof taskTypes)[number]))
    ) {
      return Response.json({ error: "INVALID_PROMPT_INPUT" }, { status: 400 });
    }
    let descriptor;
    try {
      descriptor =
        body.descriptor === undefined ? undefined : parsePromptDescriptor(body.descriptor);
    } catch {
      return Response.json({ error: "INVALID_PROMPT_INPUT" }, { status: 400 });
    }
    const created = await createPrompt({
      title: body.title.trim(),
      content: body.content,
      taskType: (body.taskType ?? "General") as (typeof taskTypes)[number],
      ...(descriptor ? { descriptor } : {}),
      description: body.description as string | undefined,
      ...(body.manualDraft === true ? { manualDraft: true } : {}),
      ...(requestKey ? { requestKey } : {}),
      adoptedUseEventIds: body.adoptedUseEventIds,
    });
    return Response.json(created, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}

export const POST = withIdentity(handlePOST);
