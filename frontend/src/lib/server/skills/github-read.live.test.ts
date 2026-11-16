import { it, expect } from "vitest";
import { APPROVED_GITHUB_IMPORT_SOURCES } from "./github-source-policy";
import {
  discoverGithubSkills,
  inspectGithubSource,
  fetchGithubSkill,
  parseGithubSkill,
} from "./github-provider";
it.skipIf(process.env.PROMPTMASTER_GITHUB_READ_TEST !== "true")(
  "reads the previously authorized real fixed writing-plans source without import, publish or model calls",
  async () => {
    const allowed = APPROVED_GITHUB_IMPORT_SOURCES[0];
    const input = {
      repositoryOwner: allowed.repositoryOwner,
      repositoryName: allowed.repositoryName,
      path: allowed.path,
      ref: allowed.ref,
    };
    const url = `https://github.com/${input.repositoryOwner}/${input.repositoryName}/tree/${input.ref}/${input.path}`;
    const found = await discoverGithubSkills(url);
    expect(found.candidates).toContainEqual(input);
    const approval = await inspectGithubSource(input, "acceptance-read-only-20261105");
    expect(approval.licenseSha256).toBe(allowed.licenseSha256);
    const bundle = await fetchGithubSkill(input, [approval]);
    const parsed = parseGithubSkill(bundle);
    expect(parsed.metadata.name).toBe("writing-plans");
    expect(parsed.body.length).toBeGreaterThan(50);
    console.info(
      "READ_ONLY_GITHUB_EVIDENCE",
      JSON.stringify({
        commit: bundle.source.commitSha,
        mainSha256: parsed.mainSha256,
        resources: parsed.resources.map((r) => ({ path: r.path, sha256: r.sha256, size: r.size })),
        mutations: 0,
        modelCalls: 0,
      }),
    );
  },
  120000,
);
