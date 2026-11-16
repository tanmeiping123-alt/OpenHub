import "server-only";
import { AccountError } from "../account-errors";
import { guardLocalDemoApi } from "../api";
import { currentActor } from "../identity-context";
import { positive } from "./validation";

export type ItemContext = { params: Promise<{ id: string }> };
export function actor() {
  const value = currentActor();
  if (!value) throw new AccountError("AUTH_REQUIRED", 401);
  return value;
}
export function query(request: Request, allowed: string[]) {
  const q = new URL(request.url).searchParams;
  if ([...q.keys()].some((k) => !allowed.includes(k) || q.getAll(k).length !== 1))
    throw new AccountError("INVALID_INPUT");
  return q;
}
export function versionParam(value: string | null) {
  if (value === null) return undefined;
  if (!/^[1-9][0-9]{0,5}$/.test(value)) throw new AccountError("INVALID_INPUT");
  return positive(Number(value));
}
export function publicRead<A extends unknown[]>(
  handler: (request: Request, ...args: A) => Promise<Response>,
) {
  return async (request: Request, ...args: A): Promise<Response> => {
    const blocked = guardLocalDemoApi(request, request.headers.has("origin"));
    if (blocked) {
      blocked.headers.set("Cache-Control", "no-store");
      return blocked;
    }
    try {
      const response = await handler(request, ...args);
      response.headers.set("Cache-Control", "no-store");
      return response;
    } catch (error) {
      return Response.json(
        { error: error instanceof AccountError ? error.code : "COMMUNITY_SERVICE_UNAVAILABLE" },
        {
          status: error instanceof AccountError ? error.status : 503,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
  };
}
