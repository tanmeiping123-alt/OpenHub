// Maintenance-only public metadata collector. Never imported by a page or Route Handler.
const ALLOWED_REPOSITORIES = new Map([
  [1073224795, "obra/superpowers"],
  [1061953414, "anthropics/skills"],
  [1112540808, "vercel-labs/agent-skills"],
]);
export const GITHUB_API_VERSION = "2026-03-10";
const MAX_RESPONSE_BYTES = 128 * 1024;

async function boundedJson(response) {
  if (!response.body || !response.headers.get("content-type")?.includes("application/json"))
    throw new Error("INVALID_METADATA");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("METADATA_TOO_LARGE");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function collectRepositoryStars(repositories, previous, options = {}) {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const now = options.now ?? (() => new Date().toISOString());
  if (
    !Array.isArray(repositories) ||
    repositories.length > ALLOWED_REPOSITORIES.size ||
    new Set(repositories.map((r) => r.id)).size !== repositories.length ||
    repositories.some((r) => ALLOWED_REPOSITORIES.get(r.id) !== r.fullName?.toLowerCase())
  )
    throw new Error("CATALOG_SOURCE_NOT_ALLOWED");
  const observations = [];
  // One request per approved repository; no retries or automatic redirect following.
  for (const repository of repositories) {
    const sourceUrl = `https://api.github.com/repos/${repository.fullName.toLowerCase()}`;
    const old = previous.find((o) => o.repositoryId === repository.id);
    const signal = AbortSignal.timeout(10000);
    let errorCode = "GITHUB_UNAVAILABLE";
    try {
      const response = await fetcher(sourceUrl, {
        method: "GET",
        redirect: "error",
        signal,
        credentials: "omit",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
          "User-Agent": "PromptMasterAI-Featured-Catalog",
        },
      });
      if (!response.ok) {
        await response.body?.cancel();
        errorCode =
          response.status === 429 || response.status === 403
            ? "GITHUB_RATE_LIMIT_OR_FORBIDDEN"
            : "GITHUB_HTTP_FAILURE";
        throw new Error(errorCode);
      }
      const metadata = await boundedJson(response);
      if (
        metadata.id !== repository.id ||
        metadata.full_name?.toLowerCase() !== repository.fullName.toLowerCase()
      ) {
        errorCode = "REPOSITORY_IDENTITY_CHANGED";
        throw new Error(errorCode);
      }
      if (
        !Number.isSafeInteger(metadata.stargazers_count) ||
        metadata.stargazers_count < 0 ||
        metadata.private !== false
      ) {
        errorCode = "INVALID_METADATA";
        throw new Error(errorCode);
      }
      const at = now();
      observations.push({
        repositoryId: repository.id,
        stars: metadata.stargazers_count,
        observedAt: at,
        sourceUrl,
        lastAttempt: { at, result: "SUCCEEDED", errorCode: null },
      });
    } catch {
      // No raw body, exception, URL redirect target, credentials, or API key in errors.
      if (signal.aborted) errorCode = "GITHUB_TIMEOUT";
      const at = now();
      const retain =
        Number.isSafeInteger(old?.stars) &&
        old.stars >= 0 &&
        typeof old.observedAt === "string" &&
        old.sourceUrl === sourceUrl;
      observations.push({
        repositoryId: repository.id,
        stars: retain ? old.stars : null,
        observedAt: retain ? old.observedAt : null,
        sourceUrl,
        lastAttempt: { at, result: "FAILED", errorCode },
      });
    }
  }
  return observations;
}
