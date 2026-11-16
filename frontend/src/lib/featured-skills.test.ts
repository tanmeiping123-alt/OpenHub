import { describe, expect, it } from "vitest";
import release from "./server/skills/catalog/featured-20261105-01.json";
import {
  formatRepositoryStars,
  isFeaturedPublication,
  rankFeaturedCandidates,
  validStars,
  type FeaturedPublication,
} from "./featured-skills";

function publication() {
  return structuredClone(release) as FeaturedPublication;
}
describe("featured metadata, not execution eligibility", () => {
  it.each([
    [0, "0"],
    [9999, "9999"],
    [10000, "1w+"],
    [12086, "1.2w+"],
    [19999, "1.9w+"],
    [100000, "10w+"],
    [123456, "12.3w+"],
    [null, "暂无数据"],
  ] as const)("Chinese lower bound %s → %s", (raw, label) => {
    expect(formatRepositoryStars(raw, "zh-CN")).toBe(label);
  });
  it.each([
    [999, "999"],
    [1000, "1K+"],
    [1999, "1.9K+"],
    [999999, "999.9K+"],
    [1000000, "1M+"],
    [1999999, "1.9M+"],
  ] as const)("English lower bound %s → %s", (raw, label) => {
    expect(formatRepositoryStars(raw, "en")).toBe(label);
  });
  it.each([NaN, Infinity, -1, 1.5, "100", undefined, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid stars %s",
    (raw) => expect(validStars(raw)).toBe(false),
  );
  it("validates the real release and ranks three repositories, not seven candidates", () => {
    expect(isFeaturedPublication(release)).toBe(true);
    expect(release.candidates).toHaveLength(7);
    expect(
      rankFeaturedCandidates(
        release.repositories,
        publication().candidates,
        publication().observations,
      ),
    ).toEqual(release.orderedEntryIds);
    expect(release.observations.map((o) => o.stars)).toEqual([312516, 187456, 33553]);
  });
  it("uses raw integers even when abbreviated strings match, and stable canonical ties", () => {
    const p = publication();
    p.observations.forEach((o, i) => {
      o.stars = [12001, 12086, 12086][i];
    });
    expect(
      rankFeaturedCandidates(p.repositories.reverse(), p.candidates.reverse(), p.observations),
    ).toEqual([
      "anthropic-frontend-design",
      "vercel-react-best-practices",
      "superpowers-brainstorming",
    ]);
  });
  it("chooses a representative once per repository; withheld candidates cannot be selected", () => {
    const p = publication();
    p.candidates[0].displayAdmission = "WITHHELD";
    expect(rankFeaturedCandidates(p.repositories, p.candidates, p.observations)[0]).toBe(
      "superpowers-writing-plans",
    );
    p.candidates[1].displayAdmission = "WITHHELD";
    expect(rankFeaturedCandidates(p.repositories, p.candidates, p.observations)).toHaveLength(2);
  });
  it("distinguishes a genuine zero from missing stars and validates failed retention", () => {
    const p = publication();
    const o = p.observations[0];
    o.stars = 0;
    expect(rankFeaturedCandidates(p.repositories, p.candidates, p.observations)).toHaveLength(3);
    o.lastAttempt = { at: p.publishedAt, result: "FAILED", errorCode: "GITHUB_HTTP_FAILURE" };
    p.orderedEntryIds = rankFeaturedCandidates(p.repositories, p.candidates, p.observations);
    expect(isFeaturedPublication(p)).toBe(true);
    o.stars = null;
    o.observedAt = null;
    p.orderedEntryIds = rankFeaturedCandidates(p.repositories, p.candidates, p.observations);
    expect(p.orderedEntryIds).toHaveLength(2);
    expect(isFeaturedPublication(p)).toBe(true);
    o.stars = 0;
    expect(isFeaturedPublication(p)).toBe(false);
  });
  it("caps ten but keeps six genuine sources as six; never pads", () => {
    const p = publication();
    const repositories = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      fullName: `owner/repo-${String(i).padStart(2, "0")}`,
    }));
    const candidates = repositories.map((r) => ({
      ...p.candidates[0],
      id: `candidate-${r.id}`,
      repositoryId: r.id,
    }));
    const observations = repositories.map((r) => ({
      ...p.observations[0],
      repositoryId: r.id,
      stars: r.id,
    }));
    expect(rankFeaturedCandidates(repositories, candidates, observations)).toHaveLength(10);
    expect(rankFeaturedCandidates(repositories.slice(0, 6), candidates, observations)).toHaveLength(
      6,
    );
  });
  it.each([
    "order",
    "duplicateId",
    "duplicateName",
    "duplicatePath",
    "badPath",
    "badLink",
    "badDate",
    "futureAttempt",
    "futureCheck",
    "badCount",
    "badHash",
    "missingObservation",
  ])("rejects corrupted saved publication: %s", (kind) => {
    const p = publication();
    if (kind === "order") p.orderedEntryIds.reverse();
    if (kind === "duplicateId") p.repositories[1].id = p.repositories[0].id;
    if (kind === "duplicateName")
      p.repositories[1].fullName = p.repositories[0].fullName.toUpperCase();
    if (kind === "duplicatePath") p.candidates[1].path = p.candidates[0].path;
    if (kind === "badPath") p.candidates[0].path = "../secret";
    if (kind === "badLink") p.observations[0].sourceUrl = "https://evil.test";
    if (kind === "badDate") p.observations[0].observedAt = "2026-02-30T03:00:00Z";
    if (kind === "futureAttempt") p.observations[0].lastAttempt.at = "2027-01-01T00:00:00Z";
    if (kind === "futureCheck") p.candidates[0].checkedAt = "2027-01-01T00:00:00Z";
    if (kind === "badCount") p.observations[0].stars = -1;
    if (kind === "badHash") p.candidates[0].mainFileSha256 = "not-a-hash";
    if (kind === "missingObservation") p.observations.pop();
    expect(isFeaturedPublication(p)).toBe(false);
  });
});
