import { withIdentity } from "@/lib/server/authenticated-route";
import { validModelSelection, modelSelection } from "@/lib/model-catalog";
import { guardLocalDemoApi, isRecord, boundedText } from "@/lib/server/api";
import { toPublicModelError } from "@/lib/server/model/model-errors";
import { generateLiveSourceModel } from "@/lib/server/model/model-service";
import type { Locale } from "@/lib/types";

export const runtime = "nodejs";

async function handlePOST(request: Request) {
  const blocked = guardLocalDemoApi(request, true);
  if (blocked) return blocked;
  try {
    const body: unknown = await request.json();
    if (
      !isRecord(body) ||
      !validModelSelection(body) ||
      !boundedText(body.promptId, 200) ||
      !boundedText(body.versionId, 200) ||
      (body.locale !== "en" && body.locale !== "zh-CN")
    ) {
      return Response.json({ error: "INVALID_LIVE_EVALUATION_ADVICE_INPUT" }, { status: 400 });
    }
    const result = await generateLiveSourceModel({
      purpose: "EVALUATION_ADVICE",
      promptId: body.promptId,
      versionId: body.versionId,
      locale: body.locale as Locale,
      signal: request.signal,
      ...modelSelection(body),
    });
    return Response.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const detail = toPublicModelError(error);
    console.error("PromptMaster live evaluation advice failed", {
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
