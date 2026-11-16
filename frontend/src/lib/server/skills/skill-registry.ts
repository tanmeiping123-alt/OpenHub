import "server-only";
import { workspaceOwnerId } from "../identity-context";
import { APPROVED_GITHUB_IMPORT_SOURCES } from "./github-source-policy";
import { grantImportedSkill } from "./skill-library";
import { withImportReuse } from "./import-advisory";
import type { Actor } from "../identity-context";
import { assertSkillCapacity } from "../billing/entitlements";
import { AccountError } from "../account-errors";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { demoUserId, withTransaction } from "../db";
import {
  bundleFingerprint,
  parseOfflineSkill,
  SkillInputError,
  snapshotBundle,
  type OfflineSkillBundle,
} from "./skill-parser";

export type ImportResult = {
  jobId: string;
  status: "REGISTERED" | "FAILED";
  versionId: string | null;
  manifestSha256: string | null;
  errorCode: string | null;
  reusedVersion?: boolean;
};
const id = (prefix: string) => `${prefix}_${randomUUID()}`;

// Internal repository boundary: caller MUST own the transaction, and owner comes from
// server identity (never a request body). Tests use rollback-only synthetic identities.
export async function registerOfflineSkillInTransaction(
  c: PoolClient,
  input: OfflineSkillBundle,
  key: string,
  owner: string,
  access?: { actor: Actor; riskAccepted: boolean },
): Promise<ImportResult> {
  if (typeof key !== "string" || !/^[a-zA-Z0-9._-]{1,120}$/.test(key))
    throw new SkillInputError("INVALID_IDEMPOTENCY_KEY");
  const bundle = snapshotBundle(input);
  const fingerprint = bundleFingerprint(bundle);
  // Serialize owner imports, including distinct keys updating the same logical installation.
  await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`skill-registry:${owner}`]);
  const previous = await c.query(
    `SELECT id AS "jobId",status,version_id AS "versionId",manifest_sha256 AS "manifestSha256",error_code AS "errorCode",payload_sha256 FROM skill_import_jobs WHERE owner_user_id=$1 AND operation='OFFLINE_IMPORT' AND idempotency_key=$2`,
    [owner, key],
  );
  if (previous.rowCount) {
    const { payload_sha256, ...result } = previous.rows[0];
    if (payload_sha256 !== fingerprint) throw new SkillInputError("IDEMPOTENCY_CONFLICT");
    if (result.status === "RECEIVED") throw new SkillInputError("IMPORT_IN_PROGRESS");
    return withImportReuse(c, owner, result as ImportResult);
  }
  const jobId = id("sij");
  await c.query(
    `INSERT INTO skill_import_jobs (id,owner_user_id,operation,idempotency_key,payload_sha256,source_snapshot,status) VALUES ($1,$2,'OFFLINE_IMPORT',$3,$4,$5,'RECEIVED')`,
    [jobId, owner, key, fingerprint, JSON.stringify(bundle.source)],
  );
  await c.query("SAVEPOINT skill_registration");
  try {
    const parsed = parseOfflineSkill(bundle);
    const sourceKey = `${bundle.source.label}/${bundle.source.directoryName}`;
    await assertSkillCapacity(c, owner, sourceKey, parsed.manifestSha256);
    const installation = await c.query(
      `INSERT INTO skills (id,owner_user_id,source_key) VALUES ($1,$2,$3) ON CONFLICT (owner_user_id,source_key) DO UPDATE SET source_key=EXCLUDED.source_key RETURNING id,retired_at`,
      [id("skl"), owner, sourceKey],
    );
    if (installation.rows[0].retired_at) throw new SkillInputError("SKILL_RETIRED");
    const skillId = installation.rows[0].id as string;
    const existing = await c.query(
      "SELECT id FROM skill_versions WHERE owner_user_id=$1 AND skill_id=$2 AND manifest_sha256=$3",
      [owner, skillId, parsed.manifestSha256],
    );
    const versionId = (existing.rows[0]?.id as string | undefined) ?? id("skv");
    if (!existing.rowCount) {
      await c.query(
        `INSERT INTO skill_versions (id,owner_user_id,skill_id,import_job_id,profile,parser_version,source_snapshot,metadata,body,main_sha256,manifest_text,manifest_sha256,warnings) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          versionId,
          owner,
          skillId,
          jobId,
          parsed.profile,
          parsed.parserVersion,
          JSON.stringify(parsed.source),
          JSON.stringify(parsed.metadata),
          parsed.body,
          parsed.mainSha256,
          JSON.stringify(parsed.manifest),
          parsed.manifestSha256,
          JSON.stringify(parsed.warnings),
        ],
      );
      for (const resource of parsed.resources)
        await c.query(
          `INSERT INTO skill_resources (owner_user_id,version_id,path,size_bytes,resource_type,content_text,sha256,git_blob_sha,quarantined) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            owner,
            versionId,
            resource.path,
            resource.size,
            resource.type,
            resource.content,
            resource.sha256,
            resource.gitBlobSha,
            resource.type === "SCRIPT_QUARANTINED",
          ],
        );
      await c.query(
        "INSERT INTO skill_version_reviews (id,owner_user_id,version_id,status,reason_code) VALUES ($1,$2,$3,'PENDING_REVIEW','OFFLINE_SOURCE_UNVERIFIED')",
        [id("svr"), owner, versionId],
      );
    }
    await c.query(
      "UPDATE skill_import_jobs SET status='REGISTERED',version_id=$3,manifest_sha256=$4,completed_at=now() WHERE owner_user_id=$1 AND id=$2",
      [owner, jobId, versionId, parsed.manifestSha256],
    );
    await c.query(
      "INSERT INTO skill_registry_events (id,owner_user_id,job_id,event_type) VALUES ($1,$2,$3,'IMPORT_REGISTERED')",
      [id("sre"), owner, jobId],
    );
    if (access) {
      if (access.actor.id !== owner) throw new SkillInputError("OWNER_RESOURCE_NOT_FOUND");
      await grantImportedSkill(c, access.actor, versionId, access.riskAccepted);
    }
    await c.query("RELEASE SAVEPOINT skill_registration");
    return {
      jobId,
      status: "REGISTERED",
      versionId,
      manifestSha256: parsed.manifestSha256,
      errorCode: null,
      reusedVersion: Boolean(existing.rowCount),
    };
  } catch (error) {
    // Recover a failed SQL statement before writing a durable, sanitized terminal job.
    // Connection loss or failure to record that terminal state rolls back the outer tx.
    await c.query("ROLLBACK TO SAVEPOINT skill_registration");
    await c.query("RELEASE SAVEPOINT skill_registration");
    const errorCode =
      error instanceof SkillInputError || error instanceof AccountError
        ? error.code
        : "REGISTRY_STORAGE_FAILED";
    await c.query(
      "UPDATE skill_import_jobs SET status='FAILED',error_code=$3,completed_at=now() WHERE owner_user_id=$1 AND id=$2",
      [owner, jobId, errorCode],
    );
    await c.query(
      "INSERT INTO skill_registry_events (id,owner_user_id,job_id,event_type,error_code) VALUES ($1,$2,$3,'IMPORT_FAILED',$4)",
      [id("sre"), owner, jobId, errorCode],
    );
    return { jobId, status: "FAILED", versionId: null, manifestSha256: null, errorCode };
  }
}

// No HTTP upload endpoint or arbitrary filesystem reader in 13B-1.
export function registerOfflineSkill(input: OfflineSkillBundle, key: string) {
  const bundle = snapshotBundle(input);
  return withTransaction((c) => registerOfflineSkillInTransaction(c, bundle, key, demoUserId));
}

export function getSkillRegistrySummary() {
  return withTransaction(async (c) => {
    const counts = await c.query(
      `SELECT
      (SELECT count(*)::integer FROM skills WHERE owner_user_id=$1 AND retired_at IS NULL) AS installed,
      (SELECT count(*)::integer FROM skill_versions WHERE owner_user_id=$1) AS versions,
      (SELECT count(*)::integer FROM skill_library_submissions WHERE owner_user_id=$1 AND status='PENDING') AS "pendingReview",
      (SELECT count(*)::integer FROM skill_versions v JOIN skills s ON s.id=v.skill_id WHERE s.retired_at IS NULL AND (EXISTS(SELECT 1 FROM skill_library_entries e WHERE e.version_id=v.id AND NOT EXISTS(SELECT 1 FROM skill_library_withdrawals w WHERE w.version_id=e.version_id)) OR EXISTS(SELECT 1 FROM skill_personal_access a WHERE a.version_id=v.id AND a.owner_user_id=$1))) AS available`,
      [workspaceOwnerId()],
    );
    return {
      stage: "13B-3",
      registry: "PERSONAL_AND_SHARED",
      ...counts.rows[0],
      githubImport: APPROVED_GITHUB_IMPORT_SOURCES.length
        ? "READY_FOR_DISABLED_IMPORT"
        : "SOURCE_APPROVAL_REQUIRED",
      approvedSources: APPROVED_GITHUB_IMPORT_SOURCES.map(
        ({ repositoryOwner, repositoryName, path, ref }) => ({
          repositoryOwner,
          repositoryName,
          path,
          ref,
        }),
      ),
      execution: "DISABLED",
    };
  });
}
