import { boundedJson } from "@/lib/server/authenticated-route";
import { AccountError } from "@/lib/server/account-errors";
import {
  accessiblePelicanFrame,
  controlAccessiblePelicanPreview,
} from "@/lib/server/pelican/preview-access";
import { pelicanImage, pelicanRoute, type PelicanIdContext } from "@/lib/server/pelican/http";
export const runtime = "nodejs";
export const GET = pelicanRoute(
  async (_request, ctx: PelicanIdContext) =>
    pelicanImage(await accessiblePelicanFrame((await ctx.params).id)),
  "optional",
);
export const POST = pelicanRoute(async (request, ctx: PelicanIdContext) => {
  const body = await boundedJson(request);
  if (
    !body ||
    typeof body !== "object" ||
    Object.keys(body).length !== 1 ||
    !("action" in body) ||
    !["pause", "resume", "close"].includes(String(body.action))
  )
    throw new AccountError("INVALID_INPUT");
  await controlAccessiblePelicanPreview(
    (await ctx.params).id,
    body.action as "pause" | "resume" | "close",
  );
  return Response.json({ ok: true });
}, "optional");
