import { DurableObject } from "cloudflare:workers";
import { containerEnvironment, forwardedRequest, publicOrigin } from "./runtime.mjs";

interface Env {
  OPENHUB_CONTAINER: DurableObjectNamespace<OpenHubContainer>;
  DATABASE_URL?: string;
  OPENHUB_PUBLIC_ORIGIN?: string;
  [key: string]: unknown;
}
const PORT = 3000;
const IDLE_MS = 5 * 60 * 1000;
const CHECK_MS = 30_000;

export class OpenHubContainer extends DurableObject<Env> {
  private token = "";
  private origin = "";
  private ready: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.token = (await ctx.storage.get<string>("controller-token")) ?? crypto.randomUUID();
      this.origin = (await ctx.storage.get<string>("public-origin")) ?? "";
      await ctx.storage.put("controller-token", this.token);
    });
  }

  async fetch(request: Request) {
    try {
      const origin = publicOrigin(request.url, this.env.OPENHUB_PUBLIC_ORIGIN);
      if (this.ctx.container!.running && this.origin !== origin) throw new Error("Public origin changed; restart the container.");
      this.ready ??= this.startAndWait(origin).catch((error: unknown) => { this.ready = undefined; throw error; });
      if (!this.ctx.container!.running) {
        this.ready = this.startAndWait(origin).catch((error: unknown) => { this.ready = undefined; throw error; });
      }
      await this.ready;
      await this.ctx.container!.setInactivityTimeout(IDLE_MS);
      await this.ctx.storage.setAlarm(Date.now() + CHECK_MS);
      // User writes are dispatched exactly once; only readiness probes are retried.
      return await this.ctx.container!.getTcpPort(PORT).fetch(forwardedRequest(request));
    } catch {
      return Response.json({ error: "CLOUD_RUNTIME_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "10" } });
    }
  }

  private async startAndWait(origin: string) {
    const container = this.ctx.container!;
    if (!container.running) {
      const env = containerEnvironment(this.env, origin, this.token);
      container.start({ enableInternet: true, env });
      this.origin = origin;
      await this.ctx.storage.put("public-origin", origin);
    }
    await container.setInactivityTimeout(IDLE_MS);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try {
        const response = await container.getTcpPort(PORT).fetch("http://container/api/health", { signal: AbortSignal.timeout(1500) });
        await response.body?.cancel();
        if (response.ok) return;
      } catch { /* The process may still be applying schema migrations. */ }
      await scheduler.wait(500);
    }
    throw new Error("Container readiness deadline exceeded.");
  }

  async alarm() {
    const container = this.ctx.container!;
    if (!container.running) { this.ready = undefined; return; }
    try {
      const response = await container.getTcpPort(PORT).fetch("http://container/api/health", {
        headers: { "x-openhub-internal-token": this.token }, signal: AbortSignal.timeout(5000),
      });
      const busy = response.headers.get("x-openhub-background-active") === "1";
      await response.body?.cancel();
      if (busy) {
        await container.setInactivityTimeout(IDLE_MS);
        await this.ctx.storage.setAlarm(Date.now() + CHECK_MS);
      }
      // An idle probe is the last one: polling must not keep an idle container alive.
    } catch { /* Platform interruption follows the existing persisted job recovery rules. */ }
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.protocol === "http:") { url.protocol = "https:"; return Response.redirect(url.toString(), 308); }
    return env.OPENHUB_CONTAINER.getByName("openhub").fetch(request);
  },
} satisfies ExportedHandler<Env>;
