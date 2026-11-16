import { withIdentity } from "@/lib/server/authenticated-route";
import { withTransaction } from "@/lib/server/db";
import { AccountError } from "@/lib/server/accounts";
import { requireActor, assertActiveActor } from "@/lib/server/skills/skill-library";
export const runtime = "nodejs";
export const GET = withIdentity(async (request: Request) => {
  const actor = requireActor(),
    p = new URL(request.url).searchParams,
    versionId = p.get("versionId");
  if ([...p.keys()].join(",") !== "versionId" || !versionId || versionId.length > 120)
    throw new AccountError("INVALID_INPUT");
  return Response.json(
    await withTransaction(async (c) => {
      await assertActiveActor(c, actor);
      if (
        !(
          await c.query("SELECT 1 FROM prompt_versions WHERE id=$1 AND owner_user_id=$2", [
            versionId,
            actor.id,
          ])
        ).rowCount
      )
        throw new AccountError("PROMPT_VERSION_NOT_FOUND", 404);
      return {
        versionId,
        sources: (
          await c.query(
            `SELECT p.skill_version_id AS "skillVersionId",v.metadata->>'name' AS name,p.evidence_kind AS "evidenceKind",p.manifest_sha256 AS "manifestSha256",p.resources,p.plan_id AS "planId",p.model_execution_id AS "executionId",w.created_at AS "withdrawnAt" FROM prompt_skill_sources p JOIN skill_versions v ON v.id=p.skill_version_id LEFT JOIN skill_library_withdrawals w ON w.version_id=v.id WHERE p.prompt_version_id=$1 AND p.owner_user_id=$2 ORDER BY p.created_at,p.id`,
            [versionId, actor.id],
          )
        ).rows,
      };
    }),
  );
}, true);
