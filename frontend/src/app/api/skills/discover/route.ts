import { withIdentity, boundedJson } from "@/lib/server/authenticated-route";
import { AccountError } from "@/lib/server/accounts";
import { discoverGithubSkills } from "@/lib/server/skills/github-provider";
import { SkillInputError } from "@/lib/server/skills/skill-parser";
import { requireActor } from "@/lib/server/skills/skill-library";
import { reserveSourcePreparation } from "@/lib/server/skills/source-preparation";
export const runtime = "nodejs";
export const POST = withIdentity(async (request: Request) => {
  const v = (await boundedJson(request)) as { url: unknown };
  if (!v || Object.keys(v).join(",") !== "url") throw new AccountError("INVALID_INPUT");
  await reserveSourcePreparation(requireActor().id);
  try {
    return Response.json(await discoverGithubSkills(v.url, { signal: request.signal }));
  } catch (e) {
    if (e instanceof SkillInputError) return Response.json({ error: e.code }, { status: 400 });
    throw e;
  }
}, true);
