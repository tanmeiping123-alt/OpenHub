/// <reference types="vite/client" />
import { dispatchApi, type ApiRoutes } from "./api-router";
import { withWorkerDatabase } from "../src/lib/server/db-workers";
const routes: ApiRoutes = import.meta.glob("../src/app/api/**/route.ts");

type Env = {
  HYPERDRIVE?: { connectionString: string };
  OPENHUB_PUBLIC_ORIGIN?: string;
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  [key: string]: unknown;
};
type Context = { waitUntil(promise: Promise<unknown>): void };

const worker = {
  async fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
    void ctx;
    const headers = { "Cache-Control": "no-store" };
    let origin: URL;
    try {
      origin = new URL(env.OPENHUB_PUBLIC_ORIGIN ?? "");
      if (origin.protocol !== "https:" || origin.origin !== env.OPENHUB_PUBLIC_ORIGIN ||
          !env.HYPERDRIVE?.connectionString || !env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY)
        throw new Error("Missing free cloud configuration");
    } catch {
      return Response.json({ error: "CLOUD_CONFIGURATION_REQUIRED" }, { status: 503, headers });
    }
    const url = new URL(request.url);
    if (url.host !== origin.host) return new Response(null, { status: 404, headers });
    if (url.protocol === "http:") {
      url.protocol = "https:";
      return Response.redirect(url.href, 308);
    }
    // Static Assets normally handles page requests before invoking this Worker.
    // Keep an explicit fallback for local runtime validation and direct dispatch.
    if (!url.pathname.startsWith("/api/")) return env.ASSETS?.fetch(request) ?? new Response(null, { status: 404 });
    const forwarded = new Headers(request.headers);
    forwarded.set("host", origin.host);
    forwarded.set("x-forwarded-host", origin.host);
    forwarded.set("x-forwarded-proto", "https");
    forwarded.delete("x-openhub-internal-token");
    try {
      return await withWorkerDatabase(env.HYPERDRIVE!.connectionString, () =>
        dispatchApi(new Request(request, { headers: forwarded }), routes),
      );
    } catch {
      return Response.json({ error: "CLOUD_RUNTIME_UNAVAILABLE" }, { status: 503, headers });
    }
  },
};
export default worker;
