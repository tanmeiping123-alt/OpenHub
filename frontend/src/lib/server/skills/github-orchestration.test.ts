import { afterEach, expect, it as baseIt, vi } from "vitest";
import { accountContext } from "../identity-context";
const it = (name: string, work: () => Promise<void>) =>
  baseIt(name, () =>
    accountContext.run(
      { id: "usr_unit_fixture", email: "fixture@example.test", role: "ADMIN" },
      work,
    ),
  );
vi.mock("../db", () => ({ demoUserId: "server-owner", withTransaction: vi.fn() }));
vi.mock("./github-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github-provider")>()),
  fetchGithubSkill: vi.fn(),
}));
import { withTransaction } from "../db";
import { fetchGithubSkill } from "./github-provider";
import { importGithubSkill } from "./github-registry";
import { fixtureInput, fixtureApproval, githubFixture } from "./github-fixture";
import { SkillInputError } from "./skill-parser";
const result = {
  jobId: "sij_synthetic",
  status: "RECEIVED" as const,
  versionId: null,
  manifestSha256: null,
  errorCode: null,
};
const work = { result, request: fixtureInput, approval: fixtureApproval, leaseToken: "test-lease" };
afterEach(() => vi.resetAllMocks());
it("commits the durable begin boundary before network dispatch, then finalizes separately", async () => {
  const order: string[] = [];
  vi.mocked(withTransaction)
    .mockImplementationOnce(async () => {
      order.push("begin-committed");
      return work;
    })
    .mockImplementationOnce(async () => {
      order.push("completion-committed");
      return { ...result, status: "REGISTERED" };
    });
  vi.mocked(fetchGithubSkill).mockImplementation(async () => {
    order.push("network");
    return githubFixture().bundle;
  });
  expect((await importGithubSkill(fixtureInput, "request")).status).toBe("REGISTERED");
  expect(order).toEqual(["begin-committed", "network", "completion-committed"]);
});
it("does not dispatch network or completion on an idempotent replay/live lease", async () => {
  vi.mocked(withTransaction).mockResolvedValue({ ...work, leaseToken: null });
  expect(await importGithubSkill(fixtureInput, "request")).toEqual(result);
  expect(fetchGithubSkill).not.toHaveBeenCalled();
  expect(withTransaction).toHaveBeenCalledTimes(1);
});
it("completes a failed/cancelled network attempt even after disconnection", async () => {
  vi.mocked(withTransaction)
    .mockResolvedValueOnce(work)
    .mockResolvedValueOnce({ ...result, status: "FAILED", errorCode: "GITHUB_IMPORT_CANCELLED" });
  vi.mocked(fetchGithubSkill).mockRejectedValue(new SkillInputError("GITHUB_IMPORT_CANCELLED"));
  const c = new AbortController();
  c.abort();
  expect((await importGithubSkill(fixtureInput, "request", c.signal)).status).toBe("FAILED");
  expect(withTransaction).toHaveBeenCalledTimes(2);
  expect(fetchGithubSkill).toHaveBeenCalledWith(fixtureInput, [fixtureApproval], {
    signal: c.signal,
  });
});
it("never reports success if completion storage fails", async () => {
  vi.mocked(withTransaction)
    .mockResolvedValueOnce(work)
    .mockRejectedValueOnce(new Error("storage unavailable"));
  vi.mocked(fetchGithubSkill).mockResolvedValue(githubFixture().bundle);
  await expect(importGithubSkill(fixtureInput, "request")).rejects.toThrow("storage unavailable");
});
