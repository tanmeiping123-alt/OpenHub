import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTransaction } from "../db";
import { currentActor, workspaceOwnerId, type Actor } from "../identity-context";
import { grantImportedSkill } from "./skill-library";
import { withImportReuse } from "./import-advisory";
import { assertSkillCapacity } from "../billing/entitlements";
import { AccountError } from "../account-errors";
import { sha256, SkillInputError } from "./skill-parser";
import { fetchGithubSkill, parseGithubSkill, type GithubSkillBundle } from "./github-provider";
import {
  APPROVED_GITHUB_IMPORT_SOURCES,
  normalizeGithubImportInput,
  requireGithubSourceApproval,
  validateGithubIdempotencyKey,
  type GithubImportInput,
  type GithubSourceApproval,
} from "./github-source-policy";

type JobStatus = "RECEIVED" | "REGISTERED" | "FAILED";
export type GithubImportResult = {
  jobId: string;
  status: JobStatus;
  versionId: string | null;
  manifestSha256: string | null;
  errorCode: string | null;
  reusedVersion?: boolean;
};
export type GithubImportWork = {
  result: GithubImportResult;
  leaseToken: string | null;
  request: GithubImportInput;
  approval: GithubSourceApproval;
};
const id = (p: string) => `${p}_${randomUUID()}`;
const columns = `id AS "jobId",status,version_id AS "versionId",manifest_sha256 AS "manifestSha256",error_code AS "errorCode"`;
const lockOwner = (c: PoolClient, owner: string) =>
  c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`skill-registry:${owner}`]);
const sourceRequest = (input: GithubImportInput, approval: GithubSourceApproval) => ({
  kind: "GITHUB",
  ...input,
  repositoryId: approval.repositoryId,
  approvalId: approval.approvalId,
  licensePath: approval.licensePath,
  licenseSha256: approval.licenseSha256,
});

async function failJob(
  c: PoolClient,
  owner: string,
  jobId: string,
  errorCode: string,
): Promise<GithubImportResult> {
  const r = await c.query(
    `UPDATE skill_import_jobs SET status='FAILED',error_code=$3,completed_at=now() WHERE owner_user_id=$1 AND id=$2 AND status='RECEIVED' RETURNING ${columns}`,
    [owner, jobId, errorCode],
  );
  if (!r.rowCount) throw new SkillInputError("IMPORT_LEASE_LOST");
  await c.query(
    "INSERT INTO skill_registry_events (id,owner_user_id,job_id,event_type,error_code) VALUES ($1,$2,$3,'IMPORT_FAILED',$4)",
    [id("sre"), owner, jobId, errorCode],
  );
  return r.rows[0];
}

// Internal transactional boundaries. The HTTP path supplies owner from server identity.
// Commit this short transaction BEFORE network dispatch: interruption retains a RECEIVED lease.
export async function beginGithubImportInTransaction(
  c: PoolClient,
  owner: string,
  value: unknown,
  key: unknown,
  approvals: readonly GithubSourceApproval[],
  leaseMs = 60000,
): Promise<GithubImportWork> {
  const input = normalizeGithubImportInput(value);
  validateGithubIdempotencyKey(key);
  const approval = requireGithubSourceApproval(input, approvals);
  if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 60000)
    throw new SkillInputError("INVALID_IMPORT_LEASE");
  const source = sourceRequest(input, approval);
  const fingerprint = sha256(JSON.stringify(source));
  await lockOwner(c, owner);
  const existing = await c.query(
    `SELECT ${columns},payload_sha256,lease_expires_at <= clock_timestamp() AS expired FROM skill_import_jobs WHERE owner_user_id=$1 AND operation='GITHUB_IMPORT' AND idempotency_key=$2 FOR UPDATE`,
    [owner, key],
  );
  if (existing.rowCount) {
    const { payload_sha256, expired, ...result } = existing.rows[0];
    if (payload_sha256 !== fingerprint) throw new SkillInputError("IDEMPOTENCY_CONFLICT");
    const terminal =
      result.status === "RECEIVED" && expired
        ? await failJob(c, owner, result.jobId, "IMPORT_INTERRUPTED")
        : result;
    // Never take over or replay a network dispatch. A manual retry needs a NEW key.
    return {
      result: await withImportReuse(c, owner, terminal as GithubImportResult),
      leaseToken: null,
      request: input,
      approval,
    };
  }
  const jobId = id("sij");
  const leaseToken = randomUUID();
  const r = await c.query(
    `INSERT INTO skill_import_jobs (id,owner_user_id,operation,idempotency_key,payload_sha256,source_snapshot,status,lease_token,lease_expires_at) VALUES ($1,$2,'GITHUB_IMPORT',$3,$4,$5,'RECEIVED',$6,clock_timestamp()+$7*interval '1 millisecond') RETURNING ${columns}`,
    [jobId, owner, key, fingerprint, JSON.stringify(source), leaseToken, leaseMs],
  );
  return { result: r.rows[0], leaseToken, request: input, approval };
}

export async function completeGithubImportInTransaction(
  c: PoolClient,
  owner: string,
  work: GithubImportWork,
  outcome: GithubSkillBundle | SkillInputError,
  access?: { actor: Actor; riskAccepted: boolean },
): Promise<GithubImportResult> {
  await lockOwner(c, owner);
  const rows = await c.query(
    `SELECT ${columns},lease_token,source_snapshot,lease_expires_at<=clock_timestamp() AS expired FROM skill_import_jobs WHERE owner_user_id=$1 AND id=$2 AND operation='GITHUB_IMPORT' FOR UPDATE`,
    [owner, work.result.jobId],
  );
  if (!rows.rowCount) throw new SkillInputError("OWNER_RESOURCE_NOT_FOUND");
  const row = rows.rows[0];
  if (row.status !== "RECEIVED")
    return withImportReuse(c, owner, {
      jobId: row.jobId,
      status: row.status,
      versionId: row.versionId,
      manifestSha256: row.manifestSha256,
      errorCode: row.errorCode,
    });
  if (!work.leaseToken || row.lease_token !== work.leaseToken)
    throw new SkillInputError("IMPORT_LEASE_LOST");
  if (row.expired) return failJob(c, owner, row.jobId, "IMPORT_INTERRUPTED");
  if (outcome instanceof SkillInputError)
    return failJob(
      c,
      owner,
      row.jobId,
      /^[A-Z_]{1,80}$/.test(outcome.code) ? outcome.code : "GITHUB_IMPORT_FAILED",
    );
  await c.query("SAVEPOINT github_registration");
  try {
    const parsed = parseGithubSkill(outcome);
    const { commitSha, rootTreeSha, skillTreeSha, ...requestSource } = parsed.source;
    // Canonical shape, not object property insertion order.
    for (const [key, value] of Object.entries(requestSource))
      if (row.source_snapshot[key] !== value) throw new SkillInputError("GITHUB_SOURCE_MISMATCH");
    if (
      Object.keys(requestSource).length !== Object.keys(row.source_snapshot).length ||
      !commitSha ||
      !rootTreeSha ||
      !skillTreeSha
    )
      throw new SkillInputError("GITHUB_SOURCE_MISMATCH");
    const sourceKey = `github:${parsed.source.repositoryId}:${parsed.source.path}`;
    await assertSkillCapacity(c, owner, sourceKey, parsed.manifestSha256);
    const installation = await c.query(
      "INSERT INTO skills (id,owner_user_id,source_key) VALUES ($1,$2,$3) ON CONFLICT (owner_user_id,source_key) DO UPDATE SET source_key=EXCLUDED.source_key RETURNING id,retired_at",
      [id("skl"), owner, sourceKey],
    );
    if (installation.rows[0].retired_at) throw new SkillInputError("SKILL_RETIRED");
    const skillId = installation.rows[0].id;
    const existing = await c.query(
      "SELECT id FROM skill_versions WHERE owner_user_id=$1 AND skill_id=$2 AND manifest_sha256=$3",
      [owner, skillId, parsed.manifestSha256],
    );
    const versionId = existing.rows[0]?.id ?? id("skv");
    if (!existing.rowCount) {
      await c.query(
        "INSERT INTO skill_versions (id,owner_user_id,skill_id,import_job_id,profile,parser_version,source_snapshot,metadata,body,main_sha256,manifest_text,manifest_sha256,warnings) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
        [
          versionId,
          owner,
          skillId,
          row.jobId,
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
          "INSERT INTO skill_resources (owner_user_id,version_id,path,size_bytes,resource_type,content_text,sha256,git_blob_sha,quarantined) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
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
        "INSERT INTO skill_version_reviews (id,owner_user_id,version_id,status,reason_code) VALUES ($1,$2,$3,'PENDING_REVIEW','GITHUB_CONTENT_UNREVIEWED')",
        [id("svr"), owner, versionId],
      );
    }
    const result = await c.query(
      `UPDATE skill_import_jobs SET status='REGISTERED',version_id=$3,manifest_sha256=$4,resolved_source=$5,completed_at=now() WHERE owner_user_id=$1 AND id=$2 AND lease_expires_at>clock_timestamp() RETURNING ${columns}`,
      [owner, row.jobId, versionId, parsed.manifestSha256, JSON.stringify(parsed.source)],
    );
    if (!result.rowCount) throw new SkillInputError("IMPORT_INTERRUPTED");
    await c.query(
      "INSERT INTO skill_registry_events (id,owner_user_id,job_id,event_type) VALUES ($1,$2,$3,'IMPORT_REGISTERED')",
      [id("sre"), owner, row.jobId],
    );
    if (access) {
      if (access.actor.id !== owner) throw new SkillInputError("OWNER_RESOURCE_NOT_FOUND");
      await grantImportedSkill(c, access.actor, versionId, access.riskAccepted);
    }
    await c.query("RELEASE SAVEPOINT github_registration");
    return { ...result.rows[0], reusedVersion: Boolean(existing.rowCount) };
  } catch (error) {
    await c.query("ROLLBACK TO SAVEPOINT github_registration");
    await c.query("RELEASE SAVEPOINT github_registration");
    return failJob(
      c,
      owner,
      row.jobId,
      error instanceof SkillInputError || error instanceof AccountError
        ? error.code
        : "REGISTRY_STORAGE_FAILED",
    );
  }
}

export async function importGithubSkill(
  value: unknown,
  key: unknown,
  signal?: AbortSignal,
  riskAccepted = false,
  approvals = APPROVED_GITHUB_IMPORT_SOURCES,
): Promise<GithubImportResult> {
  const owner = workspaceOwnerId();
  const actor = currentActor();
  if (actor?.role === "USER" && !riskAccepted)
    throw new SkillInputError("PERSONAL_RISK_ACCEPTANCE_REQUIRED");
  const work = await withTransaction((c) =>
    beginGithubImportInTransaction(c, owner, value, key, approvals),
  );
  if (!work.leaseToken) return work.result;
  let outcome: GithubSkillBundle | SkillInputError;
  try {
    outcome = await fetchGithubSkill(work.request, [work.approval], { signal });
  } catch (error) {
    outcome =
      error instanceof SkillInputError ? error : new SkillInputError("GITHUB_IMPORT_FAILED");
  }
  // Persist the outcome even if the HTTP client disconnected. Never claim a successful
  // audit if this second transaction fails; the durable lease remains for recovery.
  return withTransaction((c) =>
    completeGithubImportInTransaction(
      c,
      owner,
      work,
      outcome,
      actor ? { actor, riskAccepted } : undefined,
    ),
  );
}

export function getGithubImportJob(jobId: string) {
  return withTransaction(async (c) => {
    const r = await c.query(
      `SELECT ${columns},source_snapshot AS source,resolved_source AS "resolvedSource",lease_expires_at AS "leaseExpiresAt",status='RECEIVED' AND lease_expires_at<=clock_timestamp() AS interrupted FROM skill_import_jobs WHERE owner_user_id=$1 AND id=$2 AND operation='GITHUB_IMPORT'`,
      [workspaceOwnerId(), jobId],
    );
    if (!r.rowCount) throw new SkillInputError("OWNER_RESOURCE_NOT_FOUND");
    return withImportReuse(
      c,
      workspaceOwnerId(),
      r.rows[0] as GithubImportResult & {
        source: unknown;
        resolvedSource: unknown;
        leaseExpiresAt?: unknown;
        interrupted: boolean;
      },
    );
  });
}
