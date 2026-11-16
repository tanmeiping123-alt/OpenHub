import type { Locale } from "./types";

export type CatalogText = Record<Locale, string>;
export type FeaturedCandidate = {
  id: string;
  repositoryId: number;
  path: string;
  name: string;
  representative: boolean;
  displayAdmission: "ADMITTED" | "WITHHELD";
  summary: CatalogText;
  direction: CatalogText;
  dependencies: CatalogText;
  limitations: CatalogText;
  licenseSummary: CatalogText;
  licensePath: string | null;
  sourceCommit: string;
  mainFileSha256: string;
  checkedAt: string;
};
export type FeaturedRepository = { id: number; fullName: string };
export type StarsObservation = {
  repositoryId: number;
  stars: number | null;
  observedAt: string | null;
  sourceUrl: string;
  lastAttempt: {
    at: string;
    result: "SUCCEEDED" | "FAILED";
    errorCode: string | null;
  };
};
export type FeaturedPublication = {
  schemaVersion: 1;
  id: string;
  publishedAt: string;
  repositories: FeaturedRepository[];
  candidates: FeaturedCandidate[];
  observations: StarsObservation[];
  orderedEntryIds: string[];
};

const positiveId = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0;
export const validStars = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max = 2000): v is string =>
  typeof v === "string" &&
  v.trim().length > 0 &&
  v.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(v);
const bilingual = (v: unknown): v is CatalogText => record(v) && text(v.en) && text(v["zh-CN"]);
const timestamp = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v.replace(/(?<!\.\d{3})Z$/, ".000Z");
const safePath = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length <= 300 &&
  v.split("/").every((part) => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part));
const stableCompare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function repositoryMetadataUrl(repository: FeaturedRepository): string {
  return `https://api.github.com/repos/${repository.fullName.toLowerCase()}`;
}

export function candidateSourceUrl(
  candidate: FeaturedCandidate,
  repository: FeaturedRepository,
): string {
  return `https://github.com/${repository.fullName}/tree/${candidate.sourceCommit}/${candidate.path}`;
}

// This ranks display metadata, never executable eligibility or task suitability.
export function rankFeaturedCandidates(
  repositories: FeaturedRepository[],
  candidates: FeaturedCandidate[],
  observations: StarsObservation[],
): string[] {
  const representatives = repositories.flatMap((repository) => {
    const observation = observations.find((o) => o.repositoryId === repository.id);
    if (!validStars(observation?.stars) || !observation?.observedAt) return [];
    const eligible = candidates.filter(
      (c) => c.repositoryId === repository.id && c.displayAdmission === "ADMITTED",
    );
    eligible.sort(
      (a, b) => Number(b.representative) - Number(a.representative) || stableCompare(a.id, b.id),
    );
    return eligible.length
      ? [{ repository, stars: observation.stars, candidate: eligible[0] }]
      : [];
  });
  representatives.sort(
    (a, b) =>
      b.stars - a.stars ||
      stableCompare(a.repository.fullName.toLowerCase(), b.repository.fullName.toLowerCase()),
  );
  return representatives.slice(0, 10).map((r) => r.candidate.id);
}

export function formatRepositoryStars(stars: number | null, locale: Locale): string {
  if (!validStars(stars)) return locale === "zh-CN" ? "暂无数据" : "No data";
  if (locale === "zh-CN")
    return stars < 10000 ? String(stars) : `${Math.floor(stars / 1000) / 10}w+`;
  if (stars < 1000) return String(stars);
  if (stars < 1000000) return `${Math.floor(stars / 100) / 10}K+`;
  return `${Math.floor(stars / 100000) / 10}M+`;
}

// Validate both saved publications and browser responses; URLs are constructed, not supplied HTML.
export function isFeaturedPublication(value: unknown): value is FeaturedPublication {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !text(value.id, 100) ||
    !timestamp(value.publishedAt)
  )
    return false;
  const publishedAt = Date.parse(value.publishedAt);
  const { repositories, candidates, observations, orderedEntryIds } = value;
  if (
    !Array.isArray(repositories) ||
    repositories.length > 100 ||
    !repositories.every(
      (r) =>
        record(r) &&
        positiveId(r.id) &&
        typeof r.fullName === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(r.fullName) &&
        r.fullName.length <= 140,
    )
  )
    return false;
  if (
    new Set(repositories.map((r) => r.id)).size !== repositories.length ||
    new Set(repositories.map((r) => r.fullName.toLowerCase())).size !== repositories.length
  )
    return false;
  const ids = new Set(repositories.map((r) => r.id));
  if (
    !Array.isArray(candidates) ||
    candidates.length > 200 ||
    !candidates.every(
      (c) =>
        record(c) &&
        text(c.id, 100) &&
        ids.has(c.repositoryId) &&
        safePath(c.path) &&
        text(c.name, 120) &&
        typeof c.representative === "boolean" &&
        ["ADMITTED", "WITHHELD"].includes(String(c.displayAdmission)) &&
        [c.summary, c.direction, c.dependencies, c.limitations, c.licenseSummary].every(
          bilingual,
        ) &&
        (c.licensePath === null || safePath(c.licensePath)) &&
        typeof c.sourceCommit === "string" &&
        /^[a-f0-9]{40}$/.test(c.sourceCommit) &&
        typeof c.mainFileSha256 === "string" &&
        /^[a-f0-9]{64}$/.test(c.mainFileSha256) &&
        timestamp(c.checkedAt) &&
        Date.parse(c.checkedAt) <= publishedAt,
    )
  )
    return false;
  if (
    new Set(candidates.map((c) => c.id)).size !== candidates.length ||
    new Set(candidates.map((c) => `${c.repositoryId}:${c.path.toLowerCase()}`)).size !==
      candidates.length
  )
    return false;
  if (
    !Array.isArray(observations) ||
    observations.length !== repositories.length ||
    !observations.every((o) => {
      if (!record(o) || !ids.has(o.repositoryId) || !record(o.lastAttempt)) return false;
      const r = repositories.find((r) => r.id === o.repositoryId)!;
      const attempt = o.lastAttempt;
      if (
        o.sourceUrl !== repositoryMetadataUrl(r) ||
        !timestamp(attempt.at) ||
        Date.parse(attempt.at) > publishedAt
      )
        return false;
      if (
        !(o.stars === null && o.observedAt === null) &&
        !(
          validStars(o.stars) &&
          timestamp(o.observedAt) &&
          Date.parse(o.observedAt) <= Date.parse(attempt.at)
        )
      )
        return false;
      return attempt.result === "SUCCEEDED"
        ? validStars(o.stars) && o.observedAt === attempt.at && attempt.errorCode === null
        : attempt.result === "FAILED" &&
            typeof attempt.errorCode === "string" &&
            /^[A-Z_]{1,60}$/.test(attempt.errorCode);
    })
  )
    return false;
  if (new Set(observations.map((o) => o.repositoryId)).size !== observations.length) return false;
  if (!Array.isArray(orderedEntryIds) || !orderedEntryIds.every((id) => typeof id === "string"))
    return false;
  const expected = rankFeaturedCandidates(repositories, candidates, observations);
  return (
    orderedEntryIds.length === expected.length &&
    orderedEntryIds.every((id, i) => id === expected[i])
  );
}
