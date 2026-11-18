type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
export type ApiRoutes = Record<string, () => Promise<Record<string, unknown>>>;
export async function dispatchApi(request: Request, routes: ApiRoutes): Promise<Response> {
  const pathname = new URL(request.url).pathname.replace(/\/$/, "");
  if (/%(?:2f|5c)/i.test(pathname)) return new Response(null, { status: 404 });
  let segments: string[];
  try { segments = pathname.split("/").slice(1).map(decodeURIComponent); } catch { return new Response(null, { status: 404 }); }
  const names = Object.keys(routes).sort((a, b) => (a.match(/\[/g)?.length ?? 0) - (b.match(/\[/g)?.length ?? 0));
  for (const name of names) {
    const route = name.replace("../src/app/", "").replace("/route.ts", "").split("/");
    if (route.length !== segments.length) continue;
    const params: Record<string, string> = {};
    if (!route.every((part, i) => {
      if (part.startsWith("[") && part.endsWith("]")) { params[part.slice(1, -1)] = segments[i]; return !!segments[i]; }
      return part === segments[i];
    })) continue;
    const handlers = await routes[name]();
    const allow = Object.keys(handlers).filter(key => /^[A-Z]+$/.test(key));
    if (allow.includes("GET") && !allow.includes("HEAD")) allow.push("HEAD");
    if (!allow.includes("OPTIONS")) allow.push("OPTIONS");
    if (request.method === "OPTIONS" && !handlers.OPTIONS) return new Response(null, { status: 204, headers: { Allow: allow.join(", ") } });
    const method = request.method === "HEAD" && !handlers.HEAD ? "GET" : request.method;
    if (typeof handlers[method] !== "function") return new Response(null, { status: 405, headers: { Allow: allow.join(", "), "Cache-Control": "no-store" } });
    const response = await (handlers[method] as Handler)(request, { params: Promise.resolve(params) });
    if (request.method === "HEAD") { await response.body?.cancel(); return new Response(null, { status: response.status, headers: response.headers }); }
    return response;
  }
  return Response.json({ error: "NOT_FOUND" }, { status: 404, headers: { "Cache-Control": "no-store" } });
}
