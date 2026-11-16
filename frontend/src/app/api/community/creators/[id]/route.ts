import { withTransaction } from "@/lib/server/db";
import { publicRead, query, type ItemContext } from "@/lib/server/community/http";
import { creatorProfile } from "@/lib/server/community/service";
export const GET = publicRead(async (request: Request, context: ItemContext) => {
  query(request, []);
  const { id } = await context.params;
  return Response.json(await withTransaction((c) => creatorProfile(c, id)));
});
