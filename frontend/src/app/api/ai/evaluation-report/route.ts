import { withIdentity, boundedJson } from "@/lib/server/authenticated-route";
import { AccountError } from "@/lib/server/accounts";
import { guardLocalDemoApi, isRecord, boundedText } from "@/lib/server/api";
import { toPublicModelError } from "@/lib/server/model/model-errors";
import { generateLiveSourceModel } from "@/lib/server/model/model-service";
import { modelSelection, validModelSelection } from "@/lib/model-catalog";

export const runtime = "nodejs";
async function handlePOST(request: Request) {
  const blocked = guardLocalDemoApi(request, true);
  if (blocked) return blocked;
  try {
    const body: unknown = await boundedJson(request);
    if (
      !isRecord(body) ||
      Object.keys(body).some(
        (key) =>
          ![
            "promptId",
            "versionId",
            "locale",
            "requestKey",
            "modelKey",
            "strength",
            "maxOutputTokens",
          ].includes(key),
      ) ||
      (body.modelKey !== undefined && body.modelKey !== "deepseek-direct") ||
      !validModelSelection(body) ||
      !boundedText(body.promptId, 200) ||
      !boundedText(body.versionId, 200) ||
      (body.locale !== "en" && body.locale !== "zh-CN") ||
      typeof body.requestKey !== "string" ||
      !/^[A-Za-z0-9_-]{8,100}$/.test(body.requestKey)
    )
      return Response.json({ error: "INVALID_MODEL_EVALUATION_REQUEST" }, { status: 400 });
    const result = await generateLiveSourceModel({
      purpose: "EVALUATION_REPORT",
      promptId: body.promptId,
      versionId: body.versionId,
      locale: body.locale,
      evaluationRequestKey: body.requestKey,
      ...modelSelection(body),
      signal: request.signal,
    });
    return Response.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AccountError)
      return Response.json({ error: error.code }, { status: error.status });
    if (error instanceof SyntaxError)
      return Response.json({ error: "INVALID_MODEL_EVALUATION_REQUEST" }, { status: 400 });
    const detail = toPublicModelError(error);
    console.error("PromptMaster model evaluation failed", {
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
