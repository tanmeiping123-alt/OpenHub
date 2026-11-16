import { timingSafeEqual } from "node:crypto";
import { getPool } from "@/lib/server/db";
import { hasBackgroundWork } from "@/lib/server/runtime-activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const headers = new Headers({ "Cache-Control": "no-store" });
  const expected = process.env.OPENHUB_INTERNAL_TOKEN;
  const supplied = request.headers.get("x-openhub-internal-token") ?? "";
  if (expected && Buffer.byteLength(supplied) === Buffer.byteLength(expected) &&
      timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    headers.set("x-openhub-background-active", hasBackgroundWork() ? "1" : "0");
  }
  try {
    await getPool().query("SELECT 1 AS ready");
    return Response.json({ status: "ok" }, { headers });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503, headers });
  }
}
