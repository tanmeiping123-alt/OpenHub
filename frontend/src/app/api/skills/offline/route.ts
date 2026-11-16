import { withIdentity, boundedJson } from "@/lib/server/authenticated-route";
import { withTransaction } from "@/lib/server/db";
import { AccountError } from "@/lib/server/accounts";
import { requireActor } from "@/lib/server/skills/skill-library";
import { registerOfflineSkillInTransaction } from "@/lib/server/skills/skill-registry";
import {
  SkillInputError,
  parseOfflineSkill,
  type OfflineSkillBundle,
} from "@/lib/server/skills/skill-parser";
export const runtime = "nodejs";
export const POST = withIdentity(async (request: Request) => {
  const actor = requireActor();
  if (
    actor.role === "USER" &&
    request.headers.get("x-personal-risk-acceptance") !== "personal-risk-v1"
  )
    throw new AccountError("PERSONAL_RISK_ACCEPTANCE_REQUIRED");
  const v = (await boundedJson(request, 1500000)) as Record<string, unknown>;
  if (
    !v ||
    Object.keys(v).sort().join(",") !== "directoryName,files,origin" ||
    !["AUTHORED", "UPLOAD"].includes(String(v.origin)) ||
    typeof v.directoryName !== "string" ||
    !Array.isArray(v.files) ||
    v.files.length > 64
  )
    throw new AccountError("INVALID_INPUT");
  const files = v.files.map((f: unknown) => {
    if (
      !f ||
      typeof f !== "object" ||
      Object.keys(f).sort().join(",") !== "content,path" ||
      typeof (f as { content: unknown }).content !== "string" ||
      typeof (f as { path: unknown }).path !== "string"
    )
      throw new AccountError("INVALID_INPUT");
    return {
      path: (f as { path: string }).path,
      kind: "file" as const,
      bytes: Buffer.from((f as { content: string }).content, "utf8"),
    };
  });
  const bundle: OfflineSkillBundle = {
    source: {
      kind: "OFFLINE",
      label: v.origin === "AUTHORED" ? "user-authored" : "user-uploaded",
      directoryName: v.directoryName,
    },
    files,
  };
  try {
    parseOfflineSkill(bundle);
    const result = await withTransaction((c) =>
      registerOfflineSkillInTransaction(
        c,
        bundle,
        request.headers.get("idempotency-key") ?? "",
        actor.id,
        { actor, riskAccepted: true },
      ),
    );
    return Response.json(result);
  } catch (e) {
    if (e instanceof SkillInputError) return Response.json({ error: e.code }, { status: 400 });
    throw e;
  }
}, true);
