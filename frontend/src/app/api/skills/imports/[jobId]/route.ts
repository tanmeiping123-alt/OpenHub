import { withIdentity } from "@/lib/server/authenticated-route";
import { guardLocalDemoApi } from "@/lib/server/api";
import { getGithubImportJob } from "@/lib/server/skills/github-registry";
import { SkillInputError } from "@/lib/server/skills/skill-parser";

export const runtime = "nodejs";
async function handleGET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const headers = { "Cache-Control": "no-store" };
  const blocked = guardLocalDemoApi(request, request.headers.has("origin"));
  if (blocked) {
    blocked.headers.set("Cache-Control", "no-store");
    return blocked;
  }
  if (request.headers.get("sec-fetch-site") === "cross-site")
    return Response.json({ error: "ORIGIN_REJECTED" }, { status: 403, headers });
  const { jobId } = await context.params;
  if (new URL(request.url).search || !/^sij_[a-f0-9-]{36}$/.test(jobId))
    return Response.json({ error: "INVALID_IMPORT_JOB" }, { status: 400, headers });
  try {
    return Response.json(await getGithubImportJob(jobId), { headers });
  } catch (error) {
    return error instanceof SkillInputError && error.code === "OWNER_RESOURCE_NOT_FOUND"
      ? Response.json({ error: "OWNER_RESOURCE_NOT_FOUND" }, { status: 404, headers })
      : Response.json({ error: "GITHUB_IMPORT_UNAVAILABLE" }, { status: 503, headers });
  }
}

export const GET = withIdentity(handleGET, true);
