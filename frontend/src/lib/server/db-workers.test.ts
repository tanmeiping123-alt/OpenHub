import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ pools: [] as { query: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn>; options: Record<string, unknown> }[] }));
vi.mock("pg", () => ({ Pool: class {
  query = vi.fn(async () => ({ rows: [{ migration_name: "039_external_account_identities.sql" }], rowCount: 1 }));
  release = vi.fn();
  connect = vi.fn(async () => ({ query: this.query, release: this.release }));
  end = vi.fn(async () => {});
  constructor(public options: Record<string, unknown>) { state.pools.push(this); }
} }));
import { withWorkerDatabase, getPool, ensureDatabaseReady, withTransaction } from "./db-workers";
beforeEach(() => { state.pools.length = 0; });
afterEach(() => vi.clearAllMocks());
it("never opens or reuses a pool outside an active Worker request", () => {
  expect(() => getPool()).toThrow(/request/i);
  expect(state.pools).toHaveLength(0);
});
it("isolates overlapping requests and closes each pool after its response is consumed", async () => {
  const responses = await Promise.all(["postgresql://one", "postgresql://two"].map((url) => withWorkerDatabase(url, async () => {
    const pool = getPool();
    await Promise.resolve();
    expect(getPool()).toBe(pool);
    return new Response(url);
  })));
  expect(state.pools.map((p) => p.options.connectionString)).toEqual(["postgresql://one", "postgresql://two"]);
  expect(state.pools.every((p) => p.end.mock.calls.length === 0)).toBe(true);
  await Promise.all(responses.map((r) => r.text()));
  expect(state.pools.every((p) => p.end.mock.calls.length === 1)).toBe(true);
});
it("checks a migrated schema once per request without running filesystem migrations", async () => {
  const response = await withWorkerDatabase("postgresql://fixture", async () => {
    await Promise.all([ensureDatabaseReady(), ensureDatabaseReady()]);
    return new Response(null);
  });
  await response.text();
  expect(state.pools[0].query).toHaveBeenCalledTimes(1);
  expect(state.pools[0].query.mock.calls[0][0]).toMatch(/^SELECT .*schema_migrations/);
});
it("fails closed when operator migrations are missing", async () => {
  await expect(withWorkerDatabase("postgresql://fixture", async () => {
    getPool();
    state.pools[0].query.mockResolvedValue({ rows: [], rowCount: 0 });
    await ensureDatabaseReady();
    return new Response(null);
  })).rejects.toThrow(/migration/i);
  expect(state.pools[0].end).toHaveBeenCalledTimes(1);
});
it("rolls back a failed transaction and releases the client", async () => {
  await expect(withWorkerDatabase("postgresql://fixture", async () => {
    await withTransaction(async () => { throw new Error("fixture failure"); });
    return new Response(null);
  })).rejects.toThrow("fixture failure");
  expect(state.pools[0].query).toHaveBeenCalledWith("ROLLBACK");
  expect(state.pools[0].release).toHaveBeenCalledTimes(1);
  expect(state.pools[0].end).toHaveBeenCalledTimes(1);
});
it("retains request context during streamed rendering and cleans up on cancellation", async () => {
  const response = await withWorkerDatabase("postgresql://fixture", async () => new Response(new ReadableStream({
    pull(controller) { getPool(); controller.enqueue(new TextEncoder().encode("frame")); },
  })));
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  expect(state.pools[0].end).toHaveBeenCalledTimes(1);
});
