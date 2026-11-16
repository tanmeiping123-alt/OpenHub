import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTransaction } from "../db";
import { AccountError } from "../accounts";
import { currentActor, type Actor } from "../identity-context";
export const PERSONAL_RISK_NOTICE = "personal-risk-v1";
export function requireActor() {
  const actor = currentActor();
  if (!actor) throw new AccountError("AUTH_REQUIRED", 401);
  return actor;
}
export async function assertActiveActor(c: PoolClient, actor: Actor) {
  const table = actor.role === "ADMIN" ? "administrator_users" : "regular_users";
  if (
    !(await c.query(`SELECT user_id FROM ${table} WHERE user_id=$1 AND NOT disabled`, [actor.id]))
      .rowCount
  )
    throw new AccountError("FORBIDDEN", 403);
}
export async function grantImportedSkill(
  c: PoolClient,
  actor: Actor,
  versionId: string,
  riskAccepted: boolean,
) {
  await assertActiveActor(c, actor);
  if (actor.role === "ADMIN") {
    await c.query(
      "INSERT INTO skill_library_entries(version_id,publisher_id,publication_kind) VALUES($1,$2,'ADMIN_IMPORT') ON CONFLICT(version_id) DO NOTHING",
      [versionId, actor.id],
    );
  } else {
    if (!riskAccepted) throw new AccountError("PERSONAL_RISK_ACCEPTANCE_REQUIRED");
    await c.query(
      "INSERT INTO skill_personal_access(version_id,owner_user_id,risk_notice_version) VALUES($1,$2,$3) ON CONFLICT(version_id) DO NOTHING",
      [versionId, actor.id, PERSONAL_RISK_NOTICE],
    );
  }
}
const fromVersions = `FROM skill_versions v JOIN skills k ON k.id=v.skill_id LEFT JOIN skill_library_entries e ON e.version_id=v.id LEFT JOIN skill_library_submissions s ON s.version_id=v.id LEFT JOIN skill_library_withdrawals w ON w.version_id=v.id`;
const selectVersion = `SELECT v.id AS "versionId",v.owner_user_id AS "ownerId",v.metadata,v.metadata->>'name' AS name,v.metadata->>'description' AS description,v.source_snapshot AS source,v.main_sha256 AS "mainSha256",v.manifest_sha256 AS "manifestSha256",v.warnings,v.created_at AS "createdAt",e.publication_kind AS "publicationKind",s.id AS "submissionId",s.status AS "submissionStatus",s.review_note AS "reviewNote",s.reviewed_at AS "reviewedAt",w.reason AS "withdrawalReason",w.created_at AS "withdrawnAt" ${fromVersions}`;
export async function libraryOverview(actor = requireActor(), page = 1, query = "") {
  return withTransaction(async (c) => {
    await assertActiveActor(c, actor);
    const pageSize = 25,
      totals: Record<string, number> = {},
      groups: Record<string, Record<string, unknown>[]> = {};
    const conditions = [
      ["library", "e.version_id IS NOT NULL AND w.version_id IS NULL", "e.created_at DESC"],
      ["personal", "v.owner_user_id=$1", "v.created_at DESC"],
      ["pending", actor.role === "ADMIN" ? "s.status='PENDING'" : "false", "s.created_at"],
      [
        "history",
        actor.role === "ADMIN"
          ? "(s.status IN ('APPROVED','REJECTED') OR w.version_id IS NOT NULL)"
          : "false",
        "v.created_at DESC",
      ],
    ];
    for (const [key, condition, order] of conditions) {
      const where = `${condition} AND k.retired_at IS NULL AND (v.metadata->>'name' ILIKE $2 OR v.metadata->>'description' ILIKE $2) AND $1::text IS NOT NULL`;
      const args = [actor.id, `%${query.replace(/[\\%_]/g, "\\$&")}%`];
      totals[key] = Number(
        (await c.query(`SELECT count(*) n ${fromVersions} WHERE ${where}`, args)).rows[0].n,
      );
      groups[key] = (
        await c.query(`${selectVersion} WHERE ${where} ORDER BY ${order},v.id LIMIT $3 OFFSET $4`, [
          ...args,
          pageSize,
          (page - 1) * pageSize,
        ])
      ).rows;
    }
    const available = Number(
      (
        await c.query(
          `SELECT count(DISTINCT v.id) n ${fromVersions} WHERE k.retired_at IS NULL AND ((e.version_id IS NOT NULL AND w.version_id IS NULL) OR EXISTS(SELECT 1 FROM skill_personal_access a WHERE a.version_id=v.id AND a.owner_user_id=$1))`,
          [actor.id],
        )
      ).rows[0].n,
    );
    return {
      user: actor,
      library: groups.library,
      personal: groups.personal,
      pending: groups.pending,
      history: groups.history,
      totals,
      available,
      page,
      pageSize,
    };
  });
}
export async function recommendSkill(c: PoolClient, actor: Actor, versionId: string) {
  if (actor.role !== "USER") throw new AccountError("USER_ONLY", 403);
  await assertActiveActor(c, actor);
  const owned = await c.query(
    `SELECT v.id FROM skill_versions v JOIN skill_personal_access p ON p.version_id=v.id JOIN skills k ON k.id=v.skill_id WHERE v.id=$1 AND p.owner_user_id=$2 AND k.retired_at IS NULL`,
    [versionId, actor.id],
  );
  if (!owned.rowCount) throw new AccountError("SKILL_NOT_FOUND", 404);
  const r = await c.query(
    "INSERT INTO skill_library_submissions(id,version_id,owner_user_id) VALUES($1,$2,$3) ON CONFLICT(version_id) DO NOTHING RETURNING id,status",
    [`sls_${randomUUID()}`, versionId, actor.id],
  );
  if (r.rowCount) return r.rows[0];
  return (
    await c.query(
      "SELECT id,status FROM skill_library_submissions WHERE version_id=$1 AND owner_user_id=$2",
      [versionId, actor.id],
    )
  ).rows[0];
}
export async function reviewSkill(
  c: PoolClient,
  actor: Actor,
  submissionId: string,
  decision: "APPROVED" | "REJECTED",
  note: string,
) {
  if (actor.role !== "ADMIN") throw new AccountError("ADMIN_REQUIRED", 403);
  if (!["APPROVED", "REJECTED"].includes(decision) || !note.trim() || note.length > 2000)
    throw new AccountError("INVALID_REVIEW");
  await assertActiveActor(c, actor);
  const r = await c.query("SELECT * FROM skill_library_submissions WHERE id=$1 FOR UPDATE", [
    submissionId,
  ]);
  if (!r.rowCount) throw new AccountError("SUBMISSION_NOT_FOUND", 404);
  const row = r.rows[0];
  if (row.status !== "PENDING") {
    if (row.status === decision && row.reviewer_id === actor.id && row.review_note === note.trim())
      return { id: row.id, status: row.status };
    throw new AccountError("REVIEW_ALREADY_DECIDED", 409);
  }
  await c.query(
    "UPDATE skill_library_submissions SET status=$2,reviewer_id=$3,review_note=$4,reviewed_at=clock_timestamp() WHERE id=$1",
    [submissionId, decision, actor.id, note.trim()],
  );
  if (decision === "APPROVED")
    await c.query(
      "INSERT INTO skill_library_entries(version_id,publisher_id,publication_kind,submission_id) VALUES($1,$2,'REVIEW_APPROVED',$3)",
      [row.version_id, actor.id, submissionId],
    );
  return { id: row.id, status: decision };
}
export async function skillContent(c: PoolClient, actor: Actor, versionId: string, use = false) {
  await assertActiveActor(c, actor);
  const r = await c.query(
    `${selectVersion} WHERE v.id=$1 AND k.retired_at IS NULL AND (
    (e.version_id IS NOT NULL AND w.version_id IS NULL) OR EXISTS(SELECT 1 FROM skill_personal_access a WHERE a.version_id=v.id AND a.owner_user_id=$2)
    OR ($3='ADMIN' AND (s.id IS NOT NULL OR e.version_id IS NOT NULL)))`,
    [versionId, actor.id, actor.role],
  );
  if (!r.rowCount) throw new AccountError("SKILL_NOT_FOUND", 404);
  const version = r.rows[0];
  const accessKind =
    version.publicationKind && !version.withdrawnAt
      ? "LIBRARY"
      : (
            await c.query(
              "SELECT 1 FROM skill_personal_access WHERE version_id=$1 AND owner_user_id=$2",
              [versionId, actor.id],
            )
          ).rowCount
        ? "PERSONAL"
        : "REVIEW_ONLY";
  if (use && accessKind === "REVIEW_ONLY") throw new AccountError("SKILL_NOT_AVAILABLE", 403);
  const content = (await c.query("SELECT body FROM skill_versions WHERE id=$1", [versionId]))
    .rows[0].body;
  const resources = (
    await c.query(
      "SELECT path,resource_type AS type,sha256,quarantined,content_text AS content FROM skill_resources WHERE version_id=$1 ORDER BY path",
      [versionId],
    )
  ).rows;
  let useEventId: string | undefined;
  if (use) {
    useEventId = `sue_${randomUUID()}`;
    await c.query(
      "INSERT INTO skill_use_events(id,user_id,version_id,access_kind) VALUES($1,$2,$3,$4)",
      [useEventId, actor.id, versionId, accessKind],
    );
  }
  return {
    ...version,
    body: content,
    resources,
    accessKind,
    ...(useEventId ? { useEventId } : {}),
  };
}

export async function withdrawSkill(
  c: PoolClient,
  actor: Actor,
  versionId: string,
  reason: string,
) {
  if (actor.role !== "ADMIN") throw new AccountError("ADMIN_REQUIRED", 403);
  await assertActiveActor(c, actor);
  if (!reason.trim() || reason.length > 2000) throw new AccountError("WITHDRAWAL_REASON_REQUIRED");
  const entry = await c.query(
    "SELECT version_id FROM skill_library_entries WHERE version_id=$1 FOR UPDATE",
    [versionId],
  );
  if (!entry.rowCount) throw new AccountError("SKILL_NOT_FOUND", 404);
  await c.query(
    "INSERT INTO skill_library_withdrawals(version_id,administrator_id,reason) VALUES($1,$2,$3) ON CONFLICT(version_id) DO NOTHING",
    [versionId, actor.id, reason.trim()],
  );
  return { versionId, status: "WITHDRAWN" };
}
