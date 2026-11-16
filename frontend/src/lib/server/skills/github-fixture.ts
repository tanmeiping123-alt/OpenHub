// Project-owned synthetic GitHub responses, NOT approved production source data.
import { createHash } from "node:crypto";
import { syntheticSkill } from "./skill-fixture";
import type { GithubSourceApproval } from "./github-source-policy";
import type { GithubSkillBundle } from "./github-provider";
import { gitTreeSha, SOURCE_LICENSE_RESOURCE } from "./github-provider";
const licenseBytes = Buffer.from("Synthetic project-owned test license notice.\n");
const licenseFile = {
  path: SOURCE_LICENSE_RESOURCE,
  kind: "file" as const,
  bytes: licenseBytes,
  gitBlobSha: createHash("sha1")
    .update(`blob ${licenseBytes.length}\0`)
    .update(licenseBytes)
    .digest("hex"),
};
export const fixtureApproval: GithubSourceApproval = {
  repositoryOwner: "opc-test",
  repositoryName: "synthetic",
  repositoryId: 42,
  path: "skills/synthetic-skill",
  ref: "main",
  approvalId: "test-only-approval",
  retention: "ALLOWED_FOR_DISABLED_REVIEW",
  licensePath: "LICENSE",
  licenseSha256: createHash("sha256").update(licenseBytes).digest("hex"),
};
export const fixtureInput = {
  repositoryOwner: fixtureApproval.repositoryOwner,
  repositoryName: fixtureApproval.repositoryName,
  path: fixtureApproval.path,
  ref: fixtureApproval.ref,
};
export function githubFixture(body?: string) {
  const files = syntheticSkill(undefined, body).files.map((f) => ({
    ...f,
    gitBlobSha: createHash("sha1").update(`blob ${f.bytes.length}\0`).update(f.bytes).digest("hex"),
  }));
  const leaf = files.map((f) => ({
    path: f.path,
    type: "blob",
    mode: "100644",
    sha: f.gitBlobSha,
    size: f.bytes.length,
  }));
  const skillTreeSha = gitTreeSha(leaf);
  const parentEntries = [
    { path: "synthetic-skill", type: "tree", mode: "040000", sha: skillTreeSha },
  ];
  const parent = gitTreeSha(parentEntries);
  const rootEntries = [
    { path: "skills", type: "tree", mode: "040000", sha: parent },
    {
      path: "LICENSE",
      type: "blob",
      mode: "100644",
      sha: licenseFile.gitBlobSha,
      size: licenseBytes.length,
    },
  ];
  const rootTreeSha = gitTreeSha(rootEntries);
  const commitSha = "a".repeat(40);
  const bundle: GithubSkillBundle = {
    source: {
      kind: "GITHUB",
      ...fixtureInput,
      repositoryId: fixtureApproval.repositoryId,
      approvalId: fixtureApproval.approvalId,
      licensePath: fixtureApproval.licensePath,
      licenseSha256: fixtureApproval.licenseSha256,
      commitSha,
      rootTreeSha,
      skillTreeSha,
    },
    files: [...files, licenseFile],
  };
  const responses: Record<string, unknown> = {
    "": { id: 42, full_name: "opc-test/synthetic", private: false },
    "/commits/main": { sha: commitSha, commit: { tree: { sha: rootTreeSha } } },
    [`/git/trees/${rootTreeSha}`]: {
      sha: rootTreeSha,
      truncated: false,
      tree: rootEntries,
    },
    [`/git/trees/${parent}`]: {
      sha: parent,
      truncated: false,
      tree: [{ path: "synthetic-skill", type: "tree", mode: "040000", sha: skillTreeSha }],
    },
    [`/git/trees/${skillTreeSha}?recursive=1`]: {
      sha: skillTreeSha,
      truncated: false,
      tree: files.map((f) => ({
        path: f.path,
        type: "blob",
        mode: "100644",
        sha: f.gitBlobSha,
        size: f.bytes.length,
      })),
    },
    ...Object.fromEntries(
      [...files, licenseFile].map((f) => [
        `/git/blobs/${f.gitBlobSha}`,
        {
          sha: f.gitBlobSha,
          size: f.bytes.length,
          encoding: "base64",
          content: Buffer.from(f.bytes).toString("base64"),
        },
      ]),
    ),
  };
  return { bundle, responses, base: "https://api.github.com/repos/opc-test/synthetic" };
}
