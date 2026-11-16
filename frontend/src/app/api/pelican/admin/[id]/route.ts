import { boundedJson } from "@/lib/server/authenticated-route";
import { AccountError } from "@/lib/server/account-errors";
import { isRecord } from "@/lib/server/api";
import {
  getPelicanAdminBatch,
  publishPelicanBatch,
  rerunPelicanSample,
  withdrawPelicanBatch,
  withdrawPelicanSample,
  restorePelicanSample,
  deleteFailedPelicanSample,
  deletePelicanBatch,
} from "@/lib/server/pelican/data";
import {
  cancelUndispatchedPelicanSamples,
  preparePelicanSample,
  startPelicanBatch,
  stopPelicanBatch,
} from "@/lib/server/pelican/execution";
import { closeBatchPelicanPreviews } from "@/lib/server/pelican/preview-access";
import { pelicanRoute, type PelicanIdContext } from "@/lib/server/pelican/http";
export const runtime = "nodejs";
export const GET = pelicanRoute(async (_request, ctx: PelicanIdContext) =>
  Response.json({ batch: await getPelicanAdminBatch((await ctx.params).id) }),
);
export const POST = pelicanRoute(async (request, ctx: PelicanIdContext) => {
  const { id } = await ctx.params;
  const body = await boundedJson(request, 4096);
  if (!isRecord(body) || typeof body.action !== "string") throw new AccountError("INVALID_INPUT");
  const allowed: Record<string, string[]> = {
    run: ["action", "confirmed", "budgetFingerprint"],
    publish: ["action"],
    withdraw: ["action", "reason"],
    "withdraw-sample": ["action", "sampleId", "reason"],
    "restore-sample": ["action", "sampleId"],
    rerun: ["action", "sampleId", "requestKey", "confirmed"],
    preview: ["action", "sampleId"],
    "cancel-undispatched": ["action", "confirmed"],
    stop: ["action", "confirmed", "sampleId"],
    "delete-failed": ["action", "confirmed", "sampleId"],
    "delete-batch": ["action", "confirmed"],
  };
  const permitted = Object.hasOwn(allowed, body.action) ? allowed[body.action] : undefined;
  if (!permitted || Object.keys(body).some((k) => !permitted.includes(k)))
    throw new AccountError("INVALID_INPUT");
  let batch;
  if (body.action === "run") {
    if (body.confirmed !== true || typeof body.budgetFingerprint !== "string")
      throw new AccountError("PELICAN_CONFIRMATION_REQUIRED");
    batch = await startPelicanBatch(id, body.budgetFingerprint);
    return Response.json({ batch }, { status: 202 });
  } else if (body.action === "stop" || body.action === "delete-failed") {
    if (body.confirmed !== true) throw new AccountError("PELICAN_CONFIRMATION_REQUIRED");
    if (
      (body.sampleId !== undefined && typeof body.sampleId !== "string") ||
      (body.action === "delete-failed" && typeof body.sampleId !== "string")
    )
      throw new AccountError("INVALID_INPUT");
    batch =
      body.action === "stop"
        ? await stopPelicanBatch(id, body.sampleId as string | undefined)
        : await deleteFailedPelicanSample(id, body.sampleId as string);
  } else if (body.action === "delete-batch") {
    if (body.confirmed !== true) throw new AccountError("PELICAN_CONFIRMATION_REQUIRED");
    batch = await deletePelicanBatch(id);
  } else if (body.action === "cancel-undispatched") {
    if (body.confirmed !== true) throw new AccountError("PELICAN_CONFIRMATION_REQUIRED");
    batch = await cancelUndispatchedPelicanSamples(id);
  } else if (body.action === "publish") batch = await publishPelicanBatch(id);
  else if (body.action === "withdraw") {
    if (typeof body.reason !== "string") throw new AccountError("INVALID_INPUT");
    batch = await withdrawPelicanBatch(id, body.reason);
    await closeBatchPelicanPreviews(batch.samples.map((s) => s.id));
  } else if (body.action === "withdraw-sample") {
    if (typeof body.reason !== "string" || typeof body.sampleId !== "string")
      throw new AccountError("INVALID_INPUT");
    batch = await withdrawPelicanSample(id, body.sampleId, body.reason);
    await closeBatchPelicanPreviews([body.sampleId]);
  } else if (body.action === "restore-sample") {
    if (typeof body.sampleId !== "string") throw new AccountError("INVALID_INPUT");
    batch = await restorePelicanSample(id, body.sampleId);
  } else if (body.action === "rerun") {
    if (
      body.confirmed !== true ||
      typeof body.sampleId !== "string" ||
      typeof body.requestKey !== "string"
    )
      throw new AccountError("PELICAN_CONFIRMATION_REQUIRED");
    batch = await rerunPelicanSample(id, body.sampleId, body.requestKey);
  } else {
    const prior = await getPelicanAdminBatch(id);
    if (typeof body.sampleId !== "string" || !prior.samples.some((s) => s.id === body.sampleId))
      throw new AccountError("PELICAN_SAMPLE_NOT_FOUND", 404);
    await preparePelicanSample(body.sampleId);
    batch = await getPelicanAdminBatch(id);
  }
  return Response.json({ batch });
});
