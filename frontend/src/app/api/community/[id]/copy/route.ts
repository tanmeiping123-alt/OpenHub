import { withIdentity, boundedJson } from "@/lib/server/authenticated-route";
import { withTransaction } from "@/lib/server/db";
import { actor, query, type ItemContext } from "@/lib/server/community/http";
import { copy } from "@/lib/server/community/service";
import { exact, positive, record, requestKey } from "@/lib/server/community/validation";
export const POST = withIdentity(async (request: Request, context: ItemContext) => {
  query(request, []);
  const { id } = await context.params;
  const input = record(await boundedJson(request));
  exact(input, ["versionNumber"]);
  const number = positive(input.versionNumber);
  const key = requestKey(request.headers.get("Idempotency-Key"));
  return Response.json(await withTransaction((c) => copy(c, actor(), id, number, key)));
});
