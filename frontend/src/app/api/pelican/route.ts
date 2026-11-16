import { listPelicanPublic } from "@/lib/server/pelican/data";
import { pelicanRoute } from "@/lib/server/pelican/http";
export const runtime = "nodejs";
export const GET = pelicanRoute(
  async (request) => Response.json(await listPelicanPublic(new URL(request.url).searchParams)),
  "public",
);
