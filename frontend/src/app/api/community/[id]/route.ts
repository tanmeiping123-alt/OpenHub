import { withIdentity, boundedJson } from "@/lib/server/authenticated-route";
import { withTransaction } from "@/lib/server/db";
import {
  actor,
  publicRead,
  query,
  versionParam,
  type ItemContext,
} from "@/lib/server/community/http";
import { detail, update, withdraw } from "@/lib/server/community/service";
import { publication, requestKey } from "@/lib/server/community/validation";
export const GET = publicRead(async (request: Request, context: ItemContext) => {
  const q = query(request, ["version"]);
  const { id } = await context.params;
  const version = versionParam(q.get("version"));
  return Response.json(await withTransaction((c) => detail(c, id, version)));
});
export const PUT = withIdentity(async (request: Request, context: ItemContext) => {
  query(request, []);
  const { id } = await context.params;
  const input = publication(await boundedJson(request, 1000000), true);
  const key = requestKey(request.headers.get("Idempotency-Key"));
  return Response.json(await withTransaction((c) => update(c, actor(), id, input, key)));
});
export const DELETE = withIdentity(async (request: Request, context: ItemContext) => {
  query(request, []);
  const { id } = await context.params;
  return Response.json(await withTransaction((c) => withdraw(c, actor(), id)));
});
