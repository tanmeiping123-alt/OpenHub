import { withIdentity } from "@/lib/server/authenticated-route";
import { withTransaction } from "@/lib/server/db";
import { actor, query } from "@/lib/server/community/http";
import { list, ownedDetail } from "@/lib/server/community/service";
export const GET = withIdentity(async (request: Request) => {
  const q = query(request, ["id", "tab", "page"]);
  const id = q.get("id");
  if (id !== null) {
    query(request, ["id"]);
    return Response.json(await withTransaction((c) => ownedDetail(c, actor(), id)));
  }
  return Response.json(await withTransaction((c) => list(c, q, actor())));
});
