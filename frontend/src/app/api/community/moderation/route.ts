import { withIdentity, boundedJson } from "@/lib/server/authenticated-route";
import { withTransaction } from "@/lib/server/db";
import { actor, query } from "@/lib/server/community/http";
import { moderation, moderate } from "@/lib/server/community/service";
import { moderationInput, moderationPages, requestKey } from "@/lib/server/community/validation";
export const GET = withIdentity(async (request: Request) => {
  const q = query(request, ["id", "reportsPage", "starsPage", "eventsPage"]);
  const pages = moderationPages(q);
  return Response.json(
    await withTransaction((c) => moderation(c, actor(), q.get("id") ?? undefined, pages)),
  );
});
export const POST = withIdentity(async (request: Request) => {
  query(request, []);
  const input = moderationInput(await boundedJson(request, 10000));
  const key = requestKey(request.headers.get("Idempotency-Key"));
  return Response.json(await withTransaction((c) => moderate(c, actor(), input, key)));
});
