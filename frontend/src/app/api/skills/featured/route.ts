import { withIdentity } from "@/lib/server/authenticated-route";
import { guardLocalDemoApi } from "@/lib/server/api";
import { getFeaturedPublication } from "@/lib/server/skills/featured-catalog";

export const runtime = "nodejs";
async function handleGET(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  const blocked = guardLocalDemoApi(request, request.headers.has("origin"));
  if (blocked) {
    blocked.headers.set("Cache-Control", "no-store");
    return blocked;
  }
  if (request.headers.get("sec-fetch-site") === "cross-site")
    return Response.json({ error: "ORIGIN_REJECTED" }, { status: 403, headers });
  if (new URL(request.url).search)
    return Response.json({ error: "FEATURED_QUERY_NOT_SUPPORTED" }, { status: 400, headers });
  try {
    return Response.json(getFeaturedPublication(), { headers });
  } catch {
    return Response.json({ error: "FEATURED_CATALOG_UNAVAILABLE" }, { status: 503, headers });
  }
}

export const GET = withIdentity(handleGET);
