import { withIdentity, boundedJson } from "@/lib/server/authenticated-route";
import { AccountError } from "@/lib/server/accounts";
import { withTransaction } from "@/lib/server/db";
import { loadSkillContext } from "@/lib/server/skills/skill-context";
import {
  libraryOverview,
  requireActor,
  recommendSkill,
  reviewSkill,
  skillContent,
  withdrawSkill,
} from "@/lib/server/skills/skill-library";
export const runtime = "nodejs";
export const GET = withIdentity(async (request: Request) => {
  const url = new URL(request.url);
  if (!url.search) return Response.json(await libraryOverview());
  if ([...url.searchParams.keys()].every((k) => ["page", "q"].includes(k))) {
    const page = Number(url.searchParams.get("page") ?? 1),
      q = url.searchParams.get("q") ?? "";
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || q.length > 120)
      throw new AccountError("INVALID_INPUT");
    return Response.json(await libraryOverview(requireActor(), page, q));
  }
  if ([...url.searchParams.keys()].join(",") !== "versionId")
    throw new AccountError("INVALID_INPUT");
  const id = url.searchParams.get("versionId")!;
  if (!/^skv_[a-f0-9-]{36}$/.test(id)) throw new AccountError("INVALID_INPUT");
  return Response.json(await withTransaction((c) => skillContent(c, requireActor(), id)));
}, true);
export const POST = withIdentity(async (request: Request) => {
  const value = await boundedJson(request);
  if (!value || typeof value !== "object" || Array.isArray(value) || new URL(request.url).search)
    throw new AccountError("INVALID_INPUT");
  const v = value as Record<string, unknown>;
  const actor = requireActor();
  const keys = Object.keys(v).sort().join(",");
  if (
    v.action === "withdraw" &&
    keys === "action,reason,versionId" &&
    typeof v.versionId === "string" &&
    typeof v.reason === "string"
  )
    return Response.json(
      await withTransaction((c) =>
        withdrawSkill(c, actor, v.versionId as string, v.reason as string),
      ),
    );
  if (
    v.action === "recommend" &&
    keys === "action,shareAccepted,versionId" &&
    v.shareAccepted === true &&
    typeof v.versionId === "string"
  )
    return Response.json(
      await withTransaction((c) => recommendSkill(c, actor, v.versionId as string)),
    );
  if (
    v.action === "review" &&
    keys === "action,decision,note,submissionId" &&
    ["APPROVED", "REJECTED"].includes(String(v.decision)) &&
    typeof v.submissionId === "string" &&
    typeof v.note === "string"
  )
    return Response.json(
      await withTransaction((c) =>
        reviewSkill(
          c,
          actor,
          v.submissionId as string,
          v.decision as "APPROVED" | "REJECTED",
          v.note as string,
        ),
      ),
    );
  if (v.action === "use" && keys === "action,versionId" && typeof v.versionId === "string")
    return Response.json(
      await withTransaction(async (c) => {
        const loaded = await loadSkillContext(c, actor, v.versionId as string);
        const detail = await skillContent(c, actor, v.versionId as string, true);
        return {
          ...detail,
          adoptionText: loaded.text,
          loadedResources: loaded.selection.resources,
          resourceNotes: loaded.selection.notes,
        };
      }),
    );
  throw new AccountError("INVALID_INPUT");
}, true);
