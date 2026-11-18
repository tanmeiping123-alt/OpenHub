import { afterEach, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn(), admin: vi.fn(async () => { throw new Error("Database must not be touched"); }) }));
vi.mock("../db", () => ({ getPool: () => ({ query: db.query }), withTransaction: db.transaction }));
vi.mock("./data", () => ({ requireActivePelicanAdmin: db.admin }));
vi.mock("./renderer", () => ({ PELICAN_ADAPTER_VERSION: "fixture", preparePelicanPreview: vi.fn() }));
import { preparePelicanSample, runPelicanBatch, startPelicanBatch } from "./execution";
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it.each([preparePelicanSample, runPelicanBatch, startPelicanBatch])("rejects cloud-only unsupported work before reserving jobs or charging AI", async (work) => {
  vi.stubEnv("PROMPTMASTER_DEPLOYMENT_MODE", "cloudflare-workers");
  await expect(work("fixture", "fingerprint")).rejects.toMatchObject({ code: "PELICAN_UNAVAILABLE_ON_FREE_CLOUD", status: 503 });
  expect(db.query).not.toHaveBeenCalled();
  expect(db.transaction).not.toHaveBeenCalled();
  expect(db.admin).not.toHaveBeenCalled();
});
