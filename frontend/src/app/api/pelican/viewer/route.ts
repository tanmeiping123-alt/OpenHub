import { currentActor } from "@/lib/server/identity-context";
import { pelicanHash } from "@/lib/server/pelican/policy";
import { pelicanRoute } from "@/lib/server/pelican/http";
import { requireActivePelicanAdmin } from "@/lib/server/pelican/data";
export const runtime = "nodejs";
export const GET = pelicanRoute(async () => {
  const actor = currentActor();
  if (actor?.role === "ADMIN") await requireActivePelicanAdmin();
  return Response.json({
    role: actor?.role ?? null,
    ...(actor?.role === "ADMIN" ? { accountScope: pelicanHash(actor.id) } : {}),
  });
}, "optional");
