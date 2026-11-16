import { beforeEach, expect, it, vi } from "vitest";
import { AccountError } from "../account-errors";
const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  remove: vi.fn(),
  deleteBatch: vi.fn(),
  list: vi.fn(),
}));
vi.mock("../authenticated-route", () => ({
  withIdentity: (handler: unknown) => handler,
  boundedJson: (r: Request) => r.json(),
}));
vi.mock("./data", () => ({
  getPelicanAdminBatch: vi.fn(),
  publishPelicanBatch: vi.fn(),
  rerunPelicanSample: vi.fn(),
  withdrawPelicanBatch: vi.fn(),
  withdrawPelicanSample: vi.fn(),
  restorePelicanSample: vi.fn(),
  createPelicanBatch: vi.fn(),
  deleteFailedPelicanSample: mocks.remove,
  deletePelicanBatch: mocks.deleteBatch,
  getPelicanAdminData: mocks.list,
}));
vi.mock("./execution", () => ({
  startPelicanBatch: mocks.start,
  stopPelicanBatch: mocks.stop,
  preparePelicanSample: vi.fn(),
  cancelUndispatchedPelicanSamples: vi.fn(),
}));
vi.mock("./preview-access", () => ({ closeBatchPelicanPreviews: vi.fn() }));
import { POST } from "@/app/api/pelican/admin/[id]/route";
import { GET } from "@/app/api/pelican/admin/route";
const action = (body: unknown) =>
  POST(
    new Request("http://localhost/api/pelican/admin/b", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "b" }) },
  );
beforeEach(() => {
  vi.clearAllMocks();
  mocks.start.mockResolvedValue({ id: "b", status: "RUNNING" });
  mocks.stop.mockResolvedValue({ id: "b" });
  mocks.remove.mockResolvedValue({ id: "b" });
  mocks.deleteBatch.mockResolvedValue({ id: "b", deleted: true });
});
it("responds 202 only after durable reservation acceptance", async () => {
  expect((await action({ action: "run", confirmed: true, budgetFingerprint: "f" })).status).toBe(
    202,
  );
  expect(mocks.start).toHaveBeenCalledWith("b", "f");
  mocks.start.mockRejectedValueOnce(new AccountError("MODEL_QUOTA_EXCEEDED", 429));
  const failed = await action({ action: "run", confirmed: true, budgetFingerprint: "f" });
  expect(failed.status).toBe(429);
  expect(await failed.json()).toEqual({ error: "MODEL_QUOTA_EXCEEDED" });
});
it.each(["stop", "delete-failed"])("requires explicit confirmation for %s", async (actionName) => {
  expect((await action({ action: actionName, sampleId: "s" })).status).toBe(400);
  expect(mocks.stop).not.toHaveBeenCalled();
  expect(mocks.remove).not.toHaveBeenCalled();
});
it("routes sample and batch stop requests, protected failed deletion and batch deletion", async () => {
  expect((await action({ action: "stop", confirmed: true })).status).toBe(200);
  expect(mocks.stop).toHaveBeenLastCalledWith("b", undefined);
  expect((await action({ action: "stop", sampleId: "s", confirmed: true })).status).toBe(200);
  expect(mocks.stop).toHaveBeenLastCalledWith("b", "s");
  expect((await action({ action: "delete-failed", sampleId: "s", confirmed: true })).status).toBe(
    200,
  );
  expect(mocks.remove).toHaveBeenCalledWith("b", "s");
  expect((await action({ action: "delete-failed", confirmed: true })).status).toBe(400);
  expect((await action({ action: "delete-batch" })).status).toBe(400);
  expect((await action({ action: "delete-batch", confirmed: true })).status).toBe(200);
  expect(mocks.deleteBatch).toHaveBeenCalledWith("b");
});
it("routes sample-level withdrawal and re-publication", async () => {
  const withdraw = vi.mocked(
    (await import("./data")).withdrawPelicanSample,
  );
  const restore = vi.mocked((await import("./data")).restorePelicanSample);
  expect(
    (await action({ action: "withdraw-sample", sampleId: "s", reason: "r" })).status,
  ).toBe(200);
  expect(withdraw).toHaveBeenCalledWith("b", "s", "r");
  expect((await action({ action: "withdraw-sample", sampleId: "s" })).status).toBe(400);
  expect((await action({ action: "restore-sample", sampleId: "s" })).status).toBe(200);
  expect(restore).toHaveBeenCalledWith("b", "s");
});
it("passes bounded gallery filter arguments and rejects duplicate query keys", async () => {
  mocks.list.mockResolvedValue({ batches: [] });
  expect(
    (
      await GET(
        new Request(
          "http://localhost/api/pelican/admin?query=bird&modelKey=m&status=running&page=2",
        ),
      )
    ).status,
  ).toBe(200);
  expect(mocks.list).toHaveBeenCalledWith({
    page: 2,
    query: "bird",
    modelKey: "m",
    status: "running",
    requestKey: undefined,
    rerunRequestKey: undefined,
  });
  expect(
    (await GET(new Request("http://localhost/api/pelican/admin?status=running&status=failed")))
      .status,
  ).toBe(400);
});
