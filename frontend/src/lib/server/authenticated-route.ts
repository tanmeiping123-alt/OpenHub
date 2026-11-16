import "server-only";
import { guardLocalDemoApi } from "./api";
import { AccountError, sessionActor } from "./accounts";
import { accountContext } from "./identity-context";
export function withIdentity<A extends unknown[]>(
  handler: (request: Request, ...args: A) => Promise<Response>,
  required = true,
) {
  return async (request: Request, ...args: A): Promise<Response> => {
    const blocked = guardLocalDemoApi(
      request,
      request.method !== "GET" || request.headers.has("origin"),
    );
    if (blocked) {
      blocked.headers.set("Cache-Control", "no-store");
      return blocked;
    }
    if (request.headers.get("sec-fetch-site") === "cross-site")
      return Response.json(
        { error: "ORIGIN_REJECTED" },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    try {
      const actor = await sessionActor(request);
      if (required && !actor) throw new AccountError("AUTH_REQUIRED", 401);
      const response = await accountContext.run(actor, () => handler(request, ...args));
      response.headers.set("Cache-Control", "no-store");
      return response;
    } catch (error) {
      return Response.json(
        { error: error instanceof AccountError ? error.code : "ACCOUNT_SERVICE_UNAVAILABLE" },
        {
          status: error instanceof AccountError ? error.status : 503,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
  };
}
export async function boundedJson(request: Request, max = 4096): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json" || !request.body)
    throw new AccountError("INVALID_INPUT");
  const reader = request.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AccountError("REQUEST_TIMEOUT", 408)), 5000);
  });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > max) throw new AccountError("REQUEST_TOO_LARGE", 413);
      chunks.push(part.value);
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      throw new AccountError("INVALID_INPUT");
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
