import { withIdentity } from "@/lib/server/authenticated-route";
import { apiError, boundedText, guardLocalDemoApi, isRecord } from "@/lib/server/api";
import { updateProfileName } from "@/lib/server/services/workspace-service";

export const runtime = "nodejs";

async function handlePATCH(request: Request) {
  const blocked = guardLocalDemoApi(request, true);
  if (blocked) return blocked;
  try {
    const body: unknown = await request.json();
    if (!isRecord(body) || !boundedText(body.displayName, 120)) {
      return Response.json({ error: "INVALID_PROFILE_INPUT" }, { status: 400 });
    }
    await updateProfileName(body.displayName.trim());
    return Response.json({ displayName: body.displayName.trim() });
  } catch (error) {
    return apiError(error);
  }
}

export const PATCH = withIdentity(handlePATCH);
