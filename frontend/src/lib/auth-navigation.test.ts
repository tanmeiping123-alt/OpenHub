import { expect, it } from "vitest";
import { isWorkspacePath, safeWorkspaceNext, loginDestination } from "./auth-navigation";
it.each(["/en/pelican", "/en/pelican/manage", "/en/pelican?model=deepseek-direct"])(
  "retains a pelican return destination %s",
  (value) => {
    expect(safeWorkspaceNext(value, "en")).toBe(value);
    expect(isWorkspacePath(value)).toBe(false);
  },
);
it.each([
  "/en/pelican-evil",
  "/en/pelican/../../login",
  "/en/pelican/%2f%2fevil.test",
  "/zh-CN/pelican/manage",
  "/en/pelican/private",
])("rejects unsafe pelican destination %s", (value) => {
  expect(safeWorkspaceNext(value, "en")).toBe("/en/app");
});
it.each([
  "/en/open-prompts",
  "/en/open-prompts/new?sourceVersionId=ver_123",
  "/en/open-prompts/op_123?version=2",
  "/en/open-prompts/me?tab=starred",
])("retains a community return destination %s", (value) => {
  expect(safeWorkspaceNext(value, "en")).toBe(value);
  expect(isWorkspacePath(value)).toBe(false);
});
it.each([
  "/en/open-prompts-evil",
  "/en/open-prompts/../../login",
  "/en/open-prompts/%2f%2fevil.test",
  "/zh-CN/open-prompts",
])("rejects unsafe community destination %s", (value) => {
  expect(safeWorkspaceNext(value, "en")).toBe("/en/app");
});
it.each([
  undefined,
  null,
  [" /en/app"],
  "https://evil.test/en/app",
  "//evil.test/en/app",
  "/en/application",
  "/zh-CN/app",
  "/en/login",
  "/en/app/../../login",
  "/en/app/%2e%2e/%2e%2e/login",
  "/en/app/%2f%2fevil.test",
  "/en/app/\\evil.test",
  "/en/app/\nanything",
  "/en/app/%00",
  "/en/app?" + "x".repeat(2000),
])("rejects unsafe return destination %j", (value) => {
  expect(safeWorkspaceNext(value, "en")).toBe("/en/app");
});
it.each(["/en/app", "/en/app/generate?mode=professional", "/en/app/prompts/prm_123/edit#source"])(
  "retains a local workspace destination %s",
  (value) => {
    expect(safeWorkspaceNext(value, "en")).toBe(value);
  },
);
it("constructs a safe login destination and matches only workspace route boundaries", () => {
  const destination = new URL(
    loginDestination("/zh-CN/app/library?tag=a&tag=b", "zh-CN"),
    "http://localhost",
  );
  expect(destination.pathname).toBe("/zh-CN/login");
  expect(destination.searchParams.get("next")).toBe("/zh-CN/app/library?tag=a&tag=b");
  expect(destination.searchParams.get("reason")).toBe("required");
  expect(isWorkspacePath("/en/application")).toBe(false);
  expect(isWorkspacePath("/zh-CN/app")).toBe(true);
});
