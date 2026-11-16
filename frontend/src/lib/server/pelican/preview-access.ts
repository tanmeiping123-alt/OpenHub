import "server-only";
import { AccountError } from "../account-errors";
import { getPelicanAccessibleSample } from "./data";
import { controlPelicanPreview, openPelicanPreview, pelicanFrame } from "./renderer";

type Binding = { sampleId: string; expiresAt: number };
const globals = globalThis as typeof globalThis & { __pelicanBindings?: Map<string, Binding> };
const bindings = (globals.__pelicanBindings ??= new Map());
export async function openAccessiblePelicanPreview(sampleId: string) {
  const row = await getPelicanAccessibleSample(sampleId);
  if (row.preview_status !== "READY" || !row.preview_html)
    throw new AccountError("PELICAN_PREVIEW_NOT_SUPPORTED", 409);
  for (const [id, b] of bindings) if (b.expiresAt < Date.now()) bindings.delete(id);
  const session = await openPelicanPreview(row.preview_html);
  try {
    await getPelicanAccessibleSample(sampleId);
  } catch (error) {
    await controlPelicanPreview(session.sessionId, "close").catch(() => undefined);
    throw error;
  }
  bindings.set(session.sessionId, { sampleId, expiresAt: Date.parse(session.expiresAt) });
  return session;
}
async function accessibleSession(id: string) {
  const binding = bindings.get(id);
  if (!binding || binding.expiresAt < Date.now())
    throw new AccountError("PELICAN_PREVIEW_EXPIRED", 410);
  try {
    await getPelicanAccessibleSample(binding.sampleId);
  } catch (error) {
    bindings.delete(id);
    await controlPelicanPreview(id, "close").catch(() => undefined);
    throw error;
  }
}
export async function accessiblePelicanFrame(id: string) {
  await accessibleSession(id);
  return pelicanFrame(id);
}
export async function controlAccessiblePelicanPreview(
  id: string,
  action: "pause" | "resume" | "close",
) {
  if (action === "close" && !bindings.has(id)) return;
  await accessibleSession(id);
  await controlPelicanPreview(id, action);
  if (action === "close") bindings.delete(id);
}
export async function closeBatchPelicanPreviews(sampleIds: string[]) {
  const wanted = new Set(sampleIds);
  for (const [id, b] of bindings)
    if (wanted.has(b.sampleId)) {
      bindings.delete(id);
      await controlPelicanPreview(id, "close").catch(() => undefined);
    }
}
