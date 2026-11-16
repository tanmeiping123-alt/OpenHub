import { boundedJson } from "@/lib/server/authenticated-route";
import { AccountError } from "@/lib/server/account-errors";
import { pelicanRoute } from "@/lib/server/pelican/http";
import { openAccessiblePelicanPreview } from "@/lib/server/pelican/preview-access";
export const runtime = "nodejs";
export const POST = pelicanRoute(async (request) => {
  const body = await boundedJson(request);
  if (
    !body ||
    typeof body !== "object" ||
    Object.keys(body).length !== 1 ||
    !("sampleId" in body) ||
    typeof body.sampleId !== "string" ||
    body.sampleId.length > 100
  )
    throw new AccountError("INVALID_INPUT");
  return Response.json(await openAccessiblePelicanPreview(body.sampleId), { status: 201 });
}, "optional");
