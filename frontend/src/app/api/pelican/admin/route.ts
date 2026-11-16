import { boundedJson } from "@/lib/server/authenticated-route";
import { createPelicanBatch, getPelicanAdminData } from "@/lib/server/pelican/data";
import { pelicanRoute } from "@/lib/server/pelican/http";
import { AccountError } from "@/lib/server/account-errors";
export const runtime = "nodejs";
export const GET = pelicanRoute(async (request) => {
  const q = new URL(request.url).searchParams;
  if (
    [...q.keys()].some(
      (k) =>
        !["page", "requestKey", "rerunRequestKey", "query", "modelKey", "status"].includes(k) ||
        q.getAll(k).length !== 1,
    )
  )
    throw new AccountError("INVALID_INPUT");
  const page = q.has("page") ? Number(q.get("page")) : 1;
  return Response.json(
    await getPelicanAdminData({
      page,
      requestKey: q.get("requestKey") ?? undefined,
      rerunRequestKey: q.get("rerunRequestKey") ?? undefined,
      query: q.get("query") ?? undefined,
      modelKey: q.get("modelKey") ?? undefined,
      status: q.get("status") ?? undefined,
    }),
  );
});
export const POST = pelicanRoute(async (request) =>
  Response.json(
    { batch: await createPelicanBatch(await boundedJson(request, 8192)) },
    { status: 201 },
  ),
);
