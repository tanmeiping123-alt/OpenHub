import { randomUUID } from "node:crypto";
import { withIdentity, boundedJson } from "@/lib/server/authenticated-route";
import { AccountError } from "@/lib/server/accounts";
import { withTransaction } from "@/lib/server/db";
import { requireActor } from "@/lib/server/skills/skill-library";
import {
  inspectGithubSource,
  fetchGithubSkill,
  parseGithubSkill,
} from "@/lib/server/skills/github-provider";
import { reserveSourcePreparation } from "@/lib/server/skills/source-preparation";
import { SkillInputError } from "@/lib/server/skills/skill-parser";
import { skillImportPreview } from "@/lib/server/skills/import-advisory";
export const runtime = "nodejs";
export const POST = withIdentity(async (request: Request) => {
  const actor = requireActor();
  const body = await boundedJson(request);
  if (new URL(request.url).search) throw new AccountError("INVALID_INPUT");
  await reserveSourcePreparation(actor.id);
  const id = `sps_${randomUUID()}`;
  try {
    const approval = await inspectGithubSource(body, id, { signal: request.signal });
    const parsed =
      request.headers.get("x-skill-preview") === "true"
        ? parseGithubSkill(await fetchGithubSkill(body, [approval], { signal: request.signal }))
        : null;
    const advisory = await withTransaction(async (c) => {
      await c.query(
        "INSERT INTO skill_prepared_sources(id,owner_user_id,approval,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')",
        [id, actor.id, JSON.stringify(approval)],
      );
      return parsed
        ? skillImportPreview(
            c,
            actor.id,
            `github:${parsed.source.repositoryId}:${parsed.source.path}`,
            parsed.manifestSha256,
          )
        : undefined;
    });
    return Response.json({
      preparedSourceId: id,
      source: approval,
      expiresInSeconds: 3600,
      ...(parsed
        ? {
            preview: {
              ...advisory,
              name: parsed.metadata.name,
              description: parsed.metadata.description,
              body: parsed.body,
              warnings: parsed.warnings,
              resources: parsed.resources.map((r) => ({
                path: r.path,
                type: r.type,
                sha256: r.sha256,
                size: r.size,
              })),
            },
          }
        : {}),
    });
  } catch (error) {
    if (error instanceof SkillInputError)
      return Response.json({ error: error.code }, { status: 400 });
    throw error;
  }
}, true);
