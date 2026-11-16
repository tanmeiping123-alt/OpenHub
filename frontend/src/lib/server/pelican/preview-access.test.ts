import { beforeEach, expect, it, vi } from "vitest";
import { AccountError } from "../account-errors";
vi.mock("./data", () => ({ getPelicanAccessibleSample: vi.fn() }));
vi.mock("./renderer", () => ({
  openPelicanPreview: vi.fn(),
  controlPelicanPreview: vi.fn(async () => {}),
  pelicanFrame: vi.fn(async () => Buffer.from("pixels")),
}));
import { getPelicanAccessibleSample } from "./data";
import { openPelicanPreview, controlPelicanPreview, pelicanFrame } from "./renderer";
import { openAccessiblePelicanPreview, accessiblePelicanFrame } from "./preview-access";
beforeEach(() => {
  vi.clearAllMocks();
});
it("closes a browser when withdrawal wins the asynchronous launch race", async () => {
  vi.mocked(getPelicanAccessibleSample)
    .mockResolvedValueOnce({ preview_status: "READY", preview_html: "<svg/>" })
    .mockRejectedValueOnce(new AccountError("PELICAN_SAMPLE_NOT_FOUND", 404));
  vi.mocked(openPelicanPreview).mockResolvedValue({
    sessionId: "race-session",
    paused: false,
    expiresAt: new Date(Date.now() + 90000).toISOString(),
  });
  await expect(openAccessiblePelicanPreview("race-sample")).rejects.toMatchObject({ status: 404 });
  expect(controlPelicanPreview).toHaveBeenCalledWith("race-session", "close");
  await expect(accessiblePelicanFrame("race-session")).rejects.toMatchObject({ status: 410 });
  expect(pelicanFrame).not.toHaveBeenCalled();
});
it("rechecks every frame and terminates an already-open withdrawn preview before emitting pixels", async () => {
  vi.mocked(getPelicanAccessibleSample).mockResolvedValue({
    preview_status: "READY",
    preview_html: "<svg/>",
  });
  vi.mocked(openPelicanPreview).mockResolvedValue({
    sessionId: "withdrawn-session",
    paused: false,
    expiresAt: new Date(Date.now() + 90000).toISOString(),
  });
  await openAccessiblePelicanPreview("withdrawn-sample");
  vi.mocked(getPelicanAccessibleSample).mockRejectedValue(
    new AccountError("PELICAN_SAMPLE_NOT_FOUND", 404),
  );
  await expect(accessiblePelicanFrame("withdrawn-session")).rejects.toMatchObject({ status: 404 });
  expect(controlPelicanPreview).toHaveBeenCalledWith("withdrawn-session", "close");
  expect(pelicanFrame).not.toHaveBeenCalled();
});
