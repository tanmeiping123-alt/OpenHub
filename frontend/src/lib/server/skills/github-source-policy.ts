import "server-only";
import { SkillInputError, validateSkillPath } from "./skill-parser";

export type GithubImportInput = {
  repositoryOwner: string;
  repositoryName: string;
  path: string;
  ref: string;
};
export type GithubSourceApproval = GithubImportInput & {
  repositoryId: number;
  approvalId: string;
  retention: "ALLOWED_FOR_DISABLED_REVIEW";
  licensePath: string;
  licenseSha256: string;
};

// Deliberately independent from the public featured catalog. A catalog admission,
// repository reputation, or a client field can never grant content-retention permission.
// Add entries only after explicit repository/path/ref and retention-scope confirmation.
export const APPROVED_GITHUB_IMPORT_SOURCES: readonly GithubSourceApproval[] = Object.freeze([
  Object.freeze({
    repositoryOwner: "obra",
    repositoryName: "superpowers",
    repositoryId: 1073224795,
    path: "skills/writing-plans",
    ref: "22f0b463e7a5e579904dd6211a520321035526f7",
    approvalId: "user-writing-plans-20261105",
    retention: "ALLOWED_FOR_DISABLED_REVIEW" as const,
    licensePath: "LICENSE",
    licenseSha256: "a37e0e9697144819e1d965176ac4ae5bc3fa02d11e7812036bbcadf6dafe2400",
  }),
]);

export function normalizeGithubImportInput(value: unknown): GithubImportInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SkillInputError("INVALID_GITHUB_SOURCE");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(",") !== "path,ref,repositoryName,repositoryOwner" ||
    typeof v.repositoryOwner !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(v.repositoryOwner) ||
    typeof v.repositoryName !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(v.repositoryName) ||
    typeof v.path !== "string" ||
    v.path.length > 160 ||
    typeof v.ref !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(v.ref) ||
    v.ref
      .split("/")
      .some((p) => !p || p === "." || p === ".." || p.endsWith(".") || p.includes(".."))
  )
    throw new SkillInputError("INVALID_GITHUB_SOURCE");
  validateSkillPath(v.path);
  if (!v.path.split("/").every((p) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(p)))
    throw new SkillInputError("INVALID_GITHUB_SOURCE");
  return {
    repositoryOwner: v.repositoryOwner.toLowerCase(),
    repositoryName: v.repositoryName.toLowerCase(),
    path: v.path,
    ref: v.ref,
  };
}

export function requireGithubSourceApproval(
  input: GithubImportInput,
  approvals = APPROVED_GITHUB_IMPORT_SOURCES,
): GithubSourceApproval {
  const approval = approvals.find(
    (a) =>
      a.repositoryOwner.toLowerCase() === input.repositoryOwner &&
      a.repositoryName.toLowerCase() === input.repositoryName &&
      a.path === input.path &&
      a.ref === input.ref &&
      a.retention === "ALLOWED_FOR_DISABLED_REVIEW" &&
      Number.isSafeInteger(a.repositoryId) &&
      a.repositoryId > 0 &&
      /^[A-Za-z0-9._-]{1,120}$/.test(a.approvalId) &&
      a.licensePath === "LICENSE" &&
      /^[a-f0-9]{64}$/.test(a.licenseSha256),
  );
  if (!approval) throw new SkillInputError("GITHUB_SOURCE_APPROVAL_REQUIRED");
  return structuredClone(approval);
}

export function validateGithubIdempotencyKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,120}$/.test(value))
    throw new SkillInputError("INVALID_IDEMPOTENCY_KEY");
}
