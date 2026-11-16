import { withIdentity } from "@/lib/server/authenticated-route";
import { validModelSelection, modelSelection } from "@/lib/model-catalog";
import { guardLocalDemoApi, isRecord, boundedText } from "@/lib/server/api";
import { toPublicModelError } from "@/lib/server/model/model-errors";
import { generateLiveSourceModel } from "@/lib/server/model/model-service";
import { getPlaygroundRequestStatus } from "@/lib/server/model/model-repository";
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
      typeof body.requestKey !== "string" ||
      !/^[A-Za-z0-9_-]{8,100}$/.test(body.requestKey) ||
      (body.locale !== "en" && body.locale !== "zh-CN")
    ) {
      return Response.json({ error: "INVALID_LIVE_PLAYGROUND_INPUT" }, { status: 400 });
    }
    const result = await generateLiveSourceModel({
      purpose: "PLAYGROUND",
      playgroundRequestKey: body.requestKey,
      promptId: body.promptId,
      versionId: body.versionId,
      locale: body.locale as Locale,
      signal: request.signal,
      ...modelSelection(body),
    });
    return Response.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const detail = toPublicModelError(error);
    console.error("PromptMaster live playground failed", {
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

export const GET = withIdentity(async (request: Request) => {
  const blocked = guardLocalDemoApi(request);
  if (blocked) return blocked;
  const headers = { "Cache-Control": "no-store" };
  const requestKey = new URL(request.url).searchParams.get("requestKey");
  if (!requestKey || !/^[A-Za-z0-9_-]{8,100}$/.test(requestKey))
    return Response.json({ error: "INVALID_LIVE_PLAYGROUND_INPUT" }, { status: 400, headers });
  try {
    return Response.json(await getPlaygroundRequestStatus(requestKey), { headers });
  } catch (error) {
    const detail = toPublicModelError(error);
    return Response.json(
      { error: detail.code, message: detail.message },
      { status: detail.status, headers },
    );
  }
});
