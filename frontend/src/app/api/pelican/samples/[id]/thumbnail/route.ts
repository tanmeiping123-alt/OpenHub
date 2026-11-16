import { getPelicanAccessibleSample } from "@/lib/server/pelican/data";
import { pelicanImage, pelicanRoute, type PelicanIdContext } from "@/lib/server/pelican/http";
import { AccountError } from "@/lib/server/account-errors";
export const runtime = "nodejs";
export const GET = pelicanRoute(async (_request, ctx: PelicanIdContext) => {
  const row = await getPelicanAccessibleSample((await ctx.params).id);
  if (!row.thumbnail) throw new AccountError("PELICAN_THUMBNAIL_NOT_FOUND", 404);
  return pelicanImage(row.thumbnail);
}, "optional");
