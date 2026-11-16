import { withIdentity } from "@/lib/server/authenticated-route";
import { guardLocalDemoApi } from "@/lib/server/api";
import { toPublicModelError } from "@/lib/server/model/model-errors";
import { getLiveModelQuota } from "@/lib/server/model/model-service";

export const runtime = "nodejs";

async function handleGET(request: Request) {
  const blocked = guardLocalDemoApi(request, request.headers.has("origin"));
  if (blocked) return blocked;
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return Response.json({ error: "ORIGIN_REJECTED" }, { status: 403 });
  }
  try {
    const quota = await getLiveModelQuota();
    return Response.json(quota, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const detail = toPublicModelError(error);
    return Response.json(
      { error: detail.code, message: detail.message },
      { status: detail.status, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export const GET = withIdentity(handleGET);
