import { withIdentity } from "@/lib/server/authenticated-route";
import { guardLocalDemoApi } from "@/lib/server/api";
import { getSkillRegistrySummary } from "@/lib/server/skills/skill-registry";

export const runtime = "nodejs";
async function handleGET(request: Request) {
  const blocked = guardLocalDemoApi(request, request.headers.has("origin"));
  if (blocked) return blocked;
  if (request.headers.get("sec-fetch-site") === "cross-site")
    return Response.json({ error: "ORIGIN_REJECTED" }, { status: 403 });
  try {
    return Response.json(await getSkillRegistrySummary(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    // Never expose SQL errors, source content, local paths, or credentials.
    return Response.json(
      { error: "SKILL_REGISTRY_UNAVAILABLE" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export const GET = withIdentity(handleGET, true);
