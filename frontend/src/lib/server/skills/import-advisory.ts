import "server-only";
import type { PoolClient } from "pg";
import { SkillInputError } from "./skill-parser";

// Derive receipt facts from immutable creator identity, so retries retain the
// result of the original job rather than interpreting today's installed state.
export async function withImportReuse<
  T extends { status: string; jobId: string; versionId: string | null },
>(c: PoolClient, owner: string, result: T): Promise<T & { reusedVersion?: boolean }> {
  if (result.status !== "REGISTERED") return result;
  const row = (
    await c.query(
      'SELECT import_job_id<>$3 AS "reusedVersion" FROM skill_versions WHERE id=$1 AND owner_user_id=$2',
      [result.versionId, owner, result.jobId],
    )
  ).rows[0];
  if (!row) throw new SkillInputError("OWNER_RESOURCE_NOT_FOUND");
  return { ...result, reusedVersion: row.reusedVersion };
}

export async function skillImportPreview(
  c: PoolClient,
  owner: string,
  sourceKey: string,
  manifestSha256: string,
) {
  const version = (
    await c.query(
      "SELECT v.id,v.manifest_sha256 FROM skill_versions v JOIN skills s ON s.id=v.skill_id AND s.owner_user_id=v.owner_user_id WHERE s.owner_user_id=$1 AND s.source_key=$2 ORDER BY (v.manifest_sha256=$3) DESC,v.created_at DESC,v.id LIMIT 1",
      [owner, sourceKey, manifestSha256],
    )
  ).rows[0];
  const same = version?.manifest_sha256 === manifestSha256;
  return {
    importState: same
      ? ("SAME_VERSION" as const)
      : version
        ? ("NEW_VERSION" as const)
        : ("NEW_SKILL" as const),
    manifestSha256,
    ...(same ? { existingVersionId: String(version.id) } : {}),
  };
}
