import { expect, it } from "vitest";
import { cloudPageRoute } from "../../cloudflare/page-route";
it("preserves localized workspace routes, dynamic identifiers and query context", () => {
  expect(cloudPageRoute("/zh-CN/app/prompts/prm_123/optimize", "?versionId=ver_456")).toMatchObject({ kind: "workspace", locale: "zh-CN", page: "optimizer", promptId: "prm_123", sourceVersionId: "ver_456" });
  expect(cloudPageRoute("/en/app/playground", "?promptId=prm_1")).toMatchObject({ page: "playground", promptId: "prm_1" });
  expect(cloudPageRoute("/zh-CN/app/whiteboard")).toMatchObject({ kind: "whiteboard" });
});
it("preserves public community and admin-only Pelican route distinctions", () => {
  expect(cloudPageRoute("/en/open-prompts/creators/usr_1")).toMatchObject({ kind: "community", view: "creator", id: "usr_1" });
  expect(cloudPageRoute("/en/open-prompts/pub_1/edit")).toMatchObject({ kind: "community", view: "edit", id: "pub_1" });
  expect(cloudPageRoute("/zh-CN/pelican/manage")).toMatchObject({ kind: "pelican", manage: true });
  for (const path of ["/fr/app", "/en/pelican/anything", "/en/app/unknown", "/en/open-prompts/a/b/c"]) expect(cloudPageRoute(path)).toBeNull();
});
