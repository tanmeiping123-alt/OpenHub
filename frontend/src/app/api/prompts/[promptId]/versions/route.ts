import { withIdentity } from "@/lib/server/authenticated-route";
import {
  apiError,
  boundedText,
  guardLocalDemoApi,
  isRecord,
  validAdoptionIds,
} from "@/lib/server/api";
import { createPromptVersion } from "@/lib/server/services/prompt-service";
import { parsePromptDescriptor } from "@/lib/prompt-description";
import { MAX_PROMPT_CONTENT_CHARACTERS } from "@/lib/prompt-content";

export const runtime = "nodejs";

async function handlePOST(request: Request, context: { params: Promise<{ promptId: string }> }) {
  const blocked = guardLocalDemoApi(request, true);
  if (blocked) return blocked;
  try {
    const body: unknown = await request.json();
    if (
      !isRecord(body) ||
      !validAdoptionIds(body.adoptedUseEventIds) ||
      (body.optimizationId !== undefined && !boundedText(body.optimizationId, 120)) ||
      !boundedText(body.content, MAX_PROMPT_CONTENT_CHARACTERS) ||
      !boundedText(body.baseVersionId, 200) ||
      (body.parentVersionId !== undefined && !boundedText(body.parentVersionId, 200)) ||
      !boundedText(body.source, 80) ||
      (body.title !== undefined && !boundedText(body.title, 240))
    ) {
      return Response.json({ error: "INVALID_VERSION_INPUT" }, { status: 400 });
    }
    const { promptId } = await context.params;
    let descriptor;
    try {
      descriptor =
        body.descriptor === undefined ? undefined : parsePromptDescriptor(body.descriptor);
    } catch {
      return Response.json({ error: "INVALID_VERSION_INPUT" }, { status: 400 });
    }
    const created = await createPromptVersion({
      ...(descriptor ? { descriptor } : {}),
      promptId,
      content: body.content,
      baseVersionId: body.baseVersionId,
      parentVersionId: body.parentVersionId as string | undefined,
      source: body.source,
      title: body.title as string | undefined,
      adoptedUseEventIds: body.adoptedUseEventIds,
      optimizationId: body.optimizationId as string | undefined,
    });
    if (!created) return Response.json({ error: "PROMPT_OR_VERSION_NOT_FOUND" }, { status: 404 });
    return Response.json(created, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}

export const POST = withIdentity(handlePOST);
