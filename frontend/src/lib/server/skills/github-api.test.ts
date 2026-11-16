import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../accounts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../accounts")>()),
  sessionActor: vi.fn(async () => ({
    id: "test-actor",
    email: "test@example.test",
    role: "ADMIN",
  })),
}));
vi.mock("./github-registry", () => ({ importGithubSkill: vi.fn(), getGithubImportJob: vi.fn() }));
import { importGithubSkill, getGithubImportJob } from "./github-registry";
import { POST } from "@/app/api/skills/imports/route";
import { GET } from "@/app/api/skills/imports/[jobId]/route";
import { SkillInputError } from "./skill-parser";
const source = {
  repositoryOwner: "obra",
  repositoryName: "superpowers",
  path: "skills/writing-plans",
  ref: "22f0b463e7a5e579904dd6211a520321035526f7",
};
const jobId = "sij_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const result = {
  jobId,
  status: "REGISTERED" as const,
  versionId: "skv_test",
  manifestSha256: "a".repeat(64),
  errorCode: null,
};
function req(
  body: string = JSON.stringify(source),
  headers: Record<string, string> = {},
  query = "",
) {
  return new Request(`http://localhost:3000/api/skills/imports${query}`, {
    method: "POST",
    headers: {
      host: "localhost:3000",
      origin: "http://localhost:3000",
      "content-type": "application/json",
      "idempotency-key": "test-request",
      ...headers,
    },
    body,
  });
}
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("PROMPTMASTER_DEMO_API_ENABLED", "true");
  vi.mocked(importGithubSkill).mockReset();
  vi.mocked(getGithubImportJob).mockReset();
});
afterEach(() => vi.unstubAllEnvs());
it.each(["REGISTERED", "RECEIVED", "FAILED"] as const)(
  "returns explicit import status %s, never fakes success",
  async (status) => {
    vi.mocked(importGithubSkill).mockResolvedValue({ ...result, status });
    const r = await POST(req());
    expect(r.status).toBe(status === "RECEIVED" ? 202 : 200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect((await r.json()).status).toBe(status);
    expect(importGithubSkill).toHaveBeenCalledWith(
      source,
      "test-request",
      expect.any(AbortSignal),
      false,
      expect.any(Array),
    );
  },
);
it.each([
  ["invalid json", "{", {}, "", 400],
  ["wrong media", "{}", { "content-type": "text/plain" }, "", 400],
  ["query", "{}", {}, "?ownerId=evil", 400],
  ["declared size", "{}", { "content-length": "4097" }, "", 413],
  ["stream size", " ".repeat(4097), {}, "", 413],
] as const)("rejects %s without dispatch", async (_, body, headers, query, status) => {
  const r = await POST(req(body, headers, query));
  expect(r.status).toBe(status);
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(importGithubSkill).not.toHaveBeenCalled();
});
it.each([
  ["GITHUB_SOURCE_APPROVAL_REQUIRED", 403],
  ["IDEMPOTENCY_CONFLICT", 409],
  ["INVALID_IDEMPOTENCY_KEY", 400],
] as const)("maps safe input error %s", async (code, status) => {
  vi.mocked(importGithubSkill).mockRejectedValue(new SkillInputError(code));
  const r = await POST(req());
  expect(r.status).toBe(status);
  expect(await r.json()).toEqual({ error: code });
});
it("sanitizes storage/network exceptions", async () => {
  vi.mocked(importGithubSkill).mockRejectedValue(new Error("PRIVATE_SQL_OR_TOKEN"));
  const r = await POST(req());
  expect(r.status).toBe(503);
  expect(await r.text()).not.toContain("PRIVATE_SQL_OR_TOKEN");
});
it("bounds stalled request-body reads without dispatching", async () => {
  vi.useFakeTimers();
  try {
    const body = new ReadableStream<Uint8Array>({
      start() {
        /* intentionally never emits */
      },
    });
    const request = new Request("http://localhost:3000/api/skills/imports", {
      method: "POST",
      headers: {
        host: "localhost:3000",
        origin: "http://localhost:3000",
        "content-type": "application/json",
      },
      body,
      duplex: "half",
    } as RequestInit);
    const pending = POST(request);
    await vi.advanceTimersByTimeAsync(5000);
    const response = await pending;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "IMPORT_REQUEST_TIMEOUT" });
    expect(importGithubSkill).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
function getReq(query = "", headers: Record<string, string> = {}) {
  return new Request(`http://localhost:3000/api/skills/imports/${jobId}${query}`, {
    headers: { host: "localhost:3000", ...headers },
  });
}
const context = { params: Promise.resolve({ jobId }) };
it("returns an owner-scoped job through a no-store read without importing", async () => {
  vi.mocked(getGithubImportJob).mockResolvedValue({
    ...result,
    source,
    resolvedSource: null,
    interrupted: false,
  });
  const r = await GET(getReq(), context);
  expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect((await r.json()).jobId).toBe(jobId);
  expect(getGithubImportJob).toHaveBeenCalledWith(jobId);
  expect(importGithubSkill).not.toHaveBeenCalled();
});
it("rejects job query, malformed IDs, cross-origin and production reads", async () => {
  expect((await GET(getReq("?ownerId=evil"), context)).status).toBe(400);
  expect((await GET(getReq(), { params: Promise.resolve({ jobId: "../evil" }) })).status).toBe(400);
  expect((await GET(getReq("", { origin: "http://evil.test" }), context)).status).toBe(403);
  expect((await GET(getReq("", { "sec-fetch-site": "cross-site" }), context)).status).toBe(403);
  vi.stubEnv("NODE_ENV", "production");
  expect((await GET(getReq(), context)).status).toBe(404);
  expect(getGithubImportJob).not.toHaveBeenCalled();
});
it("job reads use owner 404 and sanitize unavailable storage", async () => {
  vi.mocked(getGithubImportJob).mockRejectedValue(new SkillInputError("OWNER_RESOURCE_NOT_FOUND"));
  expect((await GET(getReq(), context)).status).toBe(404);
  vi.mocked(getGithubImportJob).mockRejectedValue(new Error("PRIVATE_DATABASE"));
  const r = await GET(getReq(), context);
  expect(r.status).toBe(503);
  expect(await r.text()).not.toContain("PRIVATE_DATABASE");
});
