import { withIdentity, boundedJson } from "@/lib/server/authenticated-route";
import { withTransaction } from "@/lib/server/db";
import { actor, query, type ItemContext } from "@/lib/server/community/http";
import { report } from "@/lib/server/community/service";
import { reportInput, requestKey } from "@/lib/server/community/validation";
export const POST = withIdentity(async (request: Request, context: ItemContext) => {
  query(request, []);
  const { id } = await context.params;
  const input = reportInput(await boundedJson(request, 10000));
  const key = requestKey(request.headers.get("Idempotency-Key"));
  return Response.json(await withTransaction((c) => report(c, actor(), id, input, key)));
});
