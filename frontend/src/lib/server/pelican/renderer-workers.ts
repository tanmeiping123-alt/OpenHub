import { AccountError } from "../account-errors";
export const PELICAN_ADAPTER_VERSION = "free-preview-disabled-v1";
// Keep the public signatures while excluding Chromium from the Worker bundle.
export async function openPelicanPreview(html: string): Promise<{ sessionId: string; expiresAt: string; paused: boolean }> {
  void html;
  throw new AccountError("PELICAN_UNAVAILABLE_ON_FREE_CLOUD", 503);
}
export async function pelicanFrame(sessionId: string): Promise<Buffer> {
  void sessionId;
  throw new AccountError("PELICAN_UNAVAILABLE_ON_FREE_CLOUD", 503);
}
export async function controlPelicanPreview(sessionId: string, action: "pause" | "resume" | "close"): Promise<void> {
  void sessionId; void action;
  throw new AccountError("PELICAN_UNAVAILABLE_ON_FREE_CLOUD", 503);
}
export async function preparePelicanPreview(raw: string, finishReason?: string): Promise<{
  html: string | null; status: import("../../pelican-types").PelicanPreviewStatus;
  reason: string | null; thumbnail: Buffer | null; adapterVersion: string;
}> {
  void raw; void finishReason;
  throw new AccountError("PELICAN_UNAVAILABLE_ON_FREE_CLOUD", 503);
}
