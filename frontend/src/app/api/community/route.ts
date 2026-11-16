import { withIdentity, boundedJson } from "@/lib/server/authenticated-route";
import { withTransaction } from "@/lib/server/db";
import { actor, publicRead, query } from "@/lib/server/community/http";
import { list, publish } from "@/lib/server/community/service";
import { publication, requestKey } from "@/lib/server/community/validation";
export const GET = publicRead(async (request: Request) => {
  const q = query(request, [
    "q",
    "category",
    "language",
    "sort",
    "page",
    "author",
    "purpose",
    "tag",
  ]);
  return Response.json(await withTransaction((c) => list(c, q)));
});
export const POST = withIdentity(async (request: Request) => {
  query(request, []);
  const input = publication(await boundedJson(request, 1000000));
  const key = requestKey(request.headers.get("Idempotency-Key"));
  return Response.json(await withTransaction((c) => publish(c, actor(), input, key)));
});
