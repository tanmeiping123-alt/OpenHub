import "server-only";
import { withIdentity } from "../authenticated-route";
import { guardLocalDemoApi } from "../api";
import { AccountError } from "../account-errors";
import { ModelServiceError } from "../model/model-errors";
export type PelicanIdContext = { params: Promise<{ id: string }> };
export function pelicanRoute<A extends unknown[]>(
  handler: (request: Request, ...args: A) => Promise<Response>,
  identity: "required" | "optional" | "public" = "required",
) {
  const safe = async (request: Request, ...args: A) => {
    try {
      return await handler(request, ...args);
    } catch (error) {
      const known = error instanceof AccountError || error instanceof ModelServiceError;
      const status =
        error instanceof AccountError
          ? error.status
          : error instanceof ModelServiceError
            ? error.httpStatus
            : 503;
      return Response.json(
        { error: known ? error.code : "PELICAN_SERVICE_UNAVAILABLE" },
        { status, headers: { "Cache-Control": "no-store" } },
      );
    }
  };
  if (identity !== "public") return withIdentity(safe, identity === "required");
  return async (request: Request, ...args: A) => {
    const blocked = guardLocalDemoApi(
      request,
      request.method !== "GET" || request.headers.has("origin"),
    );
    if (blocked) return blocked;
    const response = await safe(request, ...args);
    response.headers.set("Cache-Control", "no-store");
    return response;
  };
}
export const pelicanImage = (bytes: Uint8Array) =>
  new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
