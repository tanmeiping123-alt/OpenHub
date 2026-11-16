import { withIdentity } from "@/lib/server/authenticated-route";
import { apiError, boundedText, guardLocalDemoApi, isRecord } from "@/lib/server/api";
import { saveOptimization } from "@/lib/server/services/prompt-service";
import { MAX_PROMPT_CONTENT_CHARACTERS } from "@/lib/prompt-content";

export const runtime = "nodejs";

async function handlePOST(request: Request, context: { params: Promise<{ promptId: string }> }) {
  const blocked = guardLocalDemoApi(request, true);
  if (blocked) return blocked;
  try {
    const body: unknown = await request.json();
    if (
      !isRecord(body) ||
      !boundedText(body.sourceVersionId, 200) ||
      !boundedText(body.proposedContent, MAX_PROMPT_CONTENT_CHARACTERS)
    ) {
      return Response.json({ error: "INVALID_OPTIMIZATION_INPUT" }, { status: 400 });
    }
    const { promptId } = await context.params;
    const saved = await saveOptimization({
      promptId,
      sourceVersionId: body.sourceVersionId,
      proposedContent: body.proposedContent,
    });
    if (!saved) return Response.json({ error: "PROMPT_VERSION_NOT_FOUND" }, { status: 404 });
    return Response.json({ source: "MOCK_SIMULATED", saved: true }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

export const POST = withIdentity(handlePOST);
