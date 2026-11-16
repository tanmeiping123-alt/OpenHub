import { withIdentity } from "@/lib/server/authenticated-route";
import { withTransaction } from "@/lib/server/db";
import { actor, query } from "@/lib/server/community/http";
import { copySource } from "@/lib/server/community/service";
import { identifier } from "@/lib/server/community/validation";
export const GET = withIdentity(async (request: Request) => {
  const promptId = identifier(query(request, ["promptId"]).get("promptId"), "prm");
  return Response.json(await withTransaction((c) => copySource(c, actor(), promptId)));
});
