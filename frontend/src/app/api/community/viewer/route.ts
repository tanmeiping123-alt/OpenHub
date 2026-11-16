import { withIdentity } from "@/lib/server/authenticated-route";
import { currentActor } from "@/lib/server/identity-context";
import { withTransaction } from "@/lib/server/db";
import { query } from "@/lib/server/community/http";
import { viewer } from "@/lib/server/community/service";
export const GET = withIdentity(async (request: Request) => {
  const q = query(request, ["id"]);
  return Response.json(
    await withTransaction((c) => viewer(c, currentActor(), q.get("id") ?? undefined)),
  );
}, false);
