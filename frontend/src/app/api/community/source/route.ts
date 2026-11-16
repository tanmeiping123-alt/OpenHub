import { withIdentity } from "@/lib/server/authenticated-route";
import { withTransaction } from "@/lib/server/db";
import { actor, query } from "@/lib/server/community/http";
import { source } from "@/lib/server/community/service";
import { identifier } from "@/lib/server/community/validation";
export const GET = withIdentity(async (request: Request) => {
  const versionId = identifier(query(request, ["versionId"]).get("versionId"), "ver");
  return Response.json(await withTransaction((c) => source(c, actor(), versionId)));
});
