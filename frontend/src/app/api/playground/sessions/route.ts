import { withIdentity } from "@/lib/server/authenticated-route";
import { apiError, boundedText, guardLocalDemoApi, isRecord } from "@/lib/server/api";
import { savePlaygroundRun } from "@/lib/server/services/workspace-service";

export const runtime = "nodejs";

async function handlePOST(request: Request) {
  const blocked = guardLocalDemoApi(request, true);
  if (blocked) return blocked;
  try {
    const body: unknown = await request.json();
    if (
      !isRecord(body) ||
      !boundedText(body.promptId, 200) ||
      !boundedText(body.versionId, 200) ||
      !Array.isArray(body.outputs) ||
      body.outputs.length < 1 ||
      body.outputs.length > 4 ||
      !body.outputs.every(
        (output) =>
          isRecord(output) && boundedText(output.name, 80) && boundedText(output.text, 200000),
      )
    ) {
      return Response.json({ error: "INVALID_PLAYGROUND_INPUT" }, { status: 400 });
    }
    const saved = await savePlaygroundRun({
      promptId: body.promptId,
      versionId: body.versionId,
      outputs: body.outputs as { name: string; text: string }[],
    });
    if (!saved) return Response.json({ error: "PROMPT_VERSION_NOT_FOUND" }, { status: 404 });
    return Response.json({ ...saved, source: "MOCK_SIMULATED" }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

export const POST = withIdentity(handlePOST);
