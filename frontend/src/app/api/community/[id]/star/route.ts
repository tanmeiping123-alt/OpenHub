import { withIdentity, boundedJson } from "@/lib/server/authenticated-route";
import { withTransaction } from "@/lib/server/db";
import { actor, query, type ItemContext } from "@/lib/server/community/http";
import { star } from "@/lib/server/community/service";
import { starInput } from "@/lib/server/community/validation";
export const PUT = withIdentity(async (request: Request, context: ItemContext) => {
  query(request, []);
  const { id } = await context.params;
  const input = starInput(await boundedJson(request));
  return Response.json(
    await withTransaction((c) => star(c, actor(), id, input.active, input.versionNumber)),
  );
});
