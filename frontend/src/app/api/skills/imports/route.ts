import { withIdentity } from "@/lib/server/authenticated-route";
import { guardLocalDemoApi } from "@/lib/server/api";
import { APPROVED_GITHUB_IMPORT_SOURCES } from "@/lib/server/skills/github-source-policy";
import {
  importGithubSkill,
  beginGithubImportInTransaction,
} from "@/lib/server/skills/github-registry";
import { SkillInputError } from "@/lib/server/skills/skill-parser";
import { withTransaction } from "@/lib/server/db";
import { currentActor } from "@/lib/server/identity-context";
import type { GithubSourceApproval } from "@/lib/server/skills/github-source-policy";

export const runtime = "nodejs";
async function handlePOST(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  const blocked = guardLocalDemoApi(request, true);
  if (blocked) {
    blocked.headers.set("Cache-Control", "no-store");
    return blocked;
  }
  if (request.headers.get("sec-fetch-site") === "cross-site")
    return Response.json({ error: "ORIGIN_REJECTED" }, { status: 403, headers });
  // A source must be preapproved or prepared by this authenticated owner.
  // An empty static allowlist must not disable owner-scoped preparation.
  try {
    if (
      new URL(request.url).search ||
      request.headers.get("content-type")?.split(";")[0] !== "application/json"
    )
      return Response.json({ error: "INVALID_IMPORT_REQUEST" }, { status: 400, headers });
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > 4096 || !request.body)
      return Response.json({ error: "IMPORT_REQUEST_TOO_LARGE" }, { status: 413, headers });
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new SkillInputError("IMPORT_REQUEST_TIMEOUT")), 5000);
    });
    try {
      while (true) {
        const part = await Promise.race([reader.read(), deadline]);
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > 4096)
          return Response.json({ error: "IMPORT_REQUEST_TOO_LARGE" }, { status: 413, headers });
        chunks.push(part.value);
      }
    } finally {
      clearTimeout(timeout);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      return Response.json({ error: "INVALID_IMPORT_REQUEST" }, { status: 400, headers });
    }
    let approvals = APPROVED_GITHUB_IMPORT_SOURCES;
    if (body && typeof body === "object" && Object.keys(body).join(",") === "preparedSourceId") {
      const preparedSourceId = (body as { preparedSourceId: unknown }).preparedSourceId;
      if (typeof preparedSourceId !== "string") throw new SkillInputError("INVALID_GITHUB_SOURCE");
      const row = await withTransaction(
        async (c) =>
          (
            await c.query(
              "SELECT approval,expires_at>clock_timestamp() AS valid FROM skill_prepared_sources WHERE id=$1 AND owner_user_id=$2",
              [preparedSourceId, currentActor()!.id],
            )
          ).rows[0],
      );
      if (!row) throw new SkillInputError("PREPARED_SOURCE_EXPIRED_OR_NOT_FOUND");
      const approval = row.approval as GithubSourceApproval;
      if (!row.valid) {
        // Expiry forbids a new fetch, but must not hide an already accepted request.
        const previous = await withTransaction(async (c) => {
          const found = (
            await c.query(
              `SELECT id FROM skill_import_jobs WHERE owner_user_id=$1 AND operation='GITHUB_IMPORT' AND idempotency_key=$2 AND source_snapshot->>'approvalId'=$3`,
              [currentActor()!.id, request.headers.get("idempotency-key"), approval.approvalId],
            )
          ).rows[0];
          if (!found) return null;
          return (
            await beginGithubImportInTransaction(
              c,
              currentActor()!.id,
              {
                repositoryOwner: approval.repositoryOwner,
                repositoryName: approval.repositoryName,
                path: approval.path,
                ref: approval.ref,
              },
              request.headers.get("idempotency-key"),
              [approval],
            )
          ).result;
        });
        if (previous) return Response.json(previous, { headers });
        throw new SkillInputError("PREPARED_SOURCE_EXPIRED_OR_NOT_FOUND");
      }
      approvals = [approval];
      body = {
        repositoryOwner: approval.repositoryOwner,
        repositoryName: approval.repositoryName,
        path: approval.path,
        ref: approval.ref,
      };
    }
    const result = await importGithubSkill(
      body,
      request.headers.get("idempotency-key"),
      request.signal,
      request.headers.get("x-personal-risk-acceptance") === "personal-risk-v1",
      approvals,
    );
    return Response.json(result, { status: result.status === "RECEIVED" ? 202 : 200, headers });
  } catch (error) {
    const code =
      error instanceof SkillInputError && /^[A-Z_]{1,80}$/.test(error.code)
        ? error.code
        : "GITHUB_IMPORT_UNAVAILABLE";
    const status =
      code === "GITHUB_SOURCE_APPROVAL_REQUIRED"
        ? 403
        : code === "IDEMPOTENCY_CONFLICT"
          ? 409
          : code === "GITHUB_IMPORT_UNAVAILABLE"
            ? 503
            : 400;
    return Response.json({ error: code }, { status, headers });
  }
}

export const POST = withIdentity(handlePOST, true);
