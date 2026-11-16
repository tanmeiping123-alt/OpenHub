import { withIdentity } from "@/lib/server/authenticated-route";
import { apiError, guardLocalDemoApi } from "@/lib/server/api";
import { bootstrapDemoWorkspace } from "@/lib/server/services/bootstrap-service";

export const runtime = "nodejs";

async function handleGET(request: Request) {
  const blocked = guardLocalDemoApi(request);
  if (blocked) return blocked;
  try {
    return Response.json(await bootstrapDemoWorkspace(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}

export const GET = withIdentity(handleGET);
