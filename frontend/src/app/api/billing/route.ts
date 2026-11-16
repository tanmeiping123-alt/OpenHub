import { withIdentity, boundedJson } from "@/lib/server/authenticated-route";
import { AccountError } from "@/lib/server/account-errors";
import { requireActor } from "@/lib/server/skills/skill-library";
import {
  adminBillingOverview,
  billingOverview,
  executeBillingCommand,
} from "@/lib/server/billing/service";

export const runtime = "nodejs";
export const GET = withIdentity(async (request: Request) => {
  const url = new URL(request.url);
  if (url.search && url.search !== "?admin=1") throw new AccountError("INVALID_INPUT");
  return Response.json(
    await (url.search ? adminBillingOverview(requireActor()) : billingOverview(requireActor())),
    { headers: { "Cache-Control": "no-store" } },
  );
}, true);
export const POST = withIdentity(async (request: Request) => {
  const actor = requireActor();
  if (new URL(request.url).search) throw new AccountError("INVALID_INPUT");
  return Response.json(await executeBillingCommand(actor, await boundedJson(request, 10000)));
}, true);
