import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  bundleFingerprint,
  parseOfflineSkill,
  sha256,
  SkillInputError,
  SKILL_LIMITS,
  snapshotBundle,
  validateSkillPath,
} from "./skill-parser";
import { syntheticSkill } from "./skill-fixture";

const base = "name: synthetic-skill\ndescription: Offline fixture";
function rejects(header: string) {
  expect(() => parseOfflineSkill(syntheticSkill(header))).toThrow(SkillInputError);
}
describe("restricted offline Skill parser", () => {
  it("preserves metadata and body, warns without granting tools or interpreting unknown fields", () => {
    const result = parseOfflineSkill(
      syntheticSkill(
        `${base}\nlicense: MIT\ncompatibility: Local text\nmetadata:\n  owner: 'project'\nallowed-tools: Bash(*)\nfuture: true`,
        "<script>untrusted()</script>\nhttps://example.invalid/secret\n",
      ),
    );
    expect(result.metadata.metadata.owner).toBe("project");
    expect(result.metadata.allowedToolsDeclaration).toBe("Bash(*)");
    expect(result.body).toContain("<script>");
    expect(result.warnings).toEqual(["SOURCE_UNVERIFIED", "UNKNOWN_FIELDS_IGNORED"]);
    expect(result.manifestSha256).toBe(sha256(JSON.stringify(result.manifest)));
    expect(result).not.toHaveProperty("permissions");
  });
  it("produces stable manifests and fingerprints independent of input ordering", () => {
    const b = syntheticSkill();
    b.files.push({ path: "references/a.md", kind: "file", bytes: Buffer.from("Reference") });
    const a = parseOfflineSkill(b);
    const fingerprint = bundleFingerprint(b);
    b.files.reverse();
    expect(parseOfflineSkill(b).manifestSha256).toBe(a.manifestSha256);
    expect(bundleFingerprint(b)).toBe(fingerprint);
    b.files[0].bytes = Buffer.from("Changed");
    expect(parseOfflineSkill(b).manifestSha256).not.toBe(a.manifestSha256);
  });
  it("copies caller-owned bytes", () => {
    const b = syntheticSkill();
    const copy = snapshotBundle(b);
    b.files[0].bytes.fill(0);
    expect(parseOfflineSkill(copy).metadata.name).toBe("synthetic-skill");
  });
  it.each([
    "../x",
    "/x",
    "C:/x",
    "//server/share",
    "a\\b",
    "a//b",
    "a/./b",
    "a/../b",
    "%2e%2e/x",
    "%252e/x",
    "a\0b",
    "a\nb",
    "a/CON.txt",
    "a/NUL",
    "a/b.",
    "a/b ",
    "a:b",
    "a/ＣＯＮ",
    "a/．/b",
    "a/\u202eb",
    ".git/config",
    "a/<b>",
    "a/" + "b/".repeat(9) + "c",
  ])("rejects unsafe path %j", (path) => {
    expect(() => validateSkillPath(path)).toThrow(SkillInputError);
  });
  it.each(["SKILL.md", "skill.MD", "references/a.md/child.txt"])(
    "rejects path collisions involving %s",
    (path) => {
      const b = syntheticSkill();
      b.files.push(
        { path: "references/a.md", kind: "file", bytes: Buffer.from("a") },
        { path, kind: "file", bytes: Buffer.from("b") },
      );
      expect(() => parseOfflineSkill(b)).toThrow("PATH_COLLISION");
    },
  );
  it("rejects Unicode compatibility normalization paths", () => {
    expect(() => validateSkillPath("references/cafe\u0301.md")).toThrow("UNSAFE_PATH");
  });
  it("catches Unicode case-fold collisions and quarantines case-varied script directories", () => {
    const b = syntheticSkill();
    b.files.push(
      { path: "references/σ.md", kind: "file", bytes: Buffer.from("a") },
      { path: "references/ς.md", kind: "file", bytes: Buffer.from("b") },
    );
    expect(() => parseOfflineSkill(b)).toThrow("PATH_COLLISION");
    b.files = [
      b.files[0],
      { path: "Scripts/readme.md", kind: "file", bytes: Buffer.from("untrusted") },
    ];
    expect(parseOfflineSkill(b).resources.find((r) => r.path === "Scripts/readme.md")?.type).toBe(
      "SCRIPT_QUARANTINED",
    );
  });
  it("accepts CRLF with exact byte hashes and never follows Markdown resource links", () => {
    const b = syntheticSkill();
    b.files[0].bytes = Buffer.from(
      "---\r\nname: synthetic-skill\r\ndescription: Fixture\r\n---\r\n[remote](https://example.invalid)\r\n",
    );
    const parsed = parseOfflineSkill(b);
    expect(parsed.resources[0].sha256).toBe(sha256(b.files[0].bytes));
    expect(parsed.body).toBe("[remote](https://example.invalid)\r\n");
    expect(parsed.resources).toHaveLength(1);
  });
  it.each(["symlink", "submodule"] as const)("rejects %s entries", (kind) => {
    const b = syntheticSkill();
    b.files[0].kind = kind;
    expect(() => parseOfflineSkill(b)).toThrow("NON_REGULAR_FILE");
  });
  it.each([
    Buffer.from([0xc3, 0x28]),
    Buffer.from("bad\0text"),
    Buffer.from([0xef, 0xbb, 0xbf, 65]),
  ])("rejects invalid or unsupported UTF8 %j", (bytes) => {
    const b = syntheticSkill();
    b.files[0].bytes = bytes;
    expect(() => parseOfflineSkill(b)).toThrow(SkillInputError);
  });
  it("rejects binary assets and LFS external pointers", () => {
    const b = syntheticSkill();
    b.files.push({ path: "assets/a.png", kind: "file", bytes: Buffer.from([1, 2]) });
    expect(() => parseOfflineSkill(b)).toThrow("UNSUPPORTED_RESOURCE");
    b.files[1] = {
      path: "assets/a.txt",
      kind: "file",
      bytes: Buffer.from("version https://git-lfs.github.com/spec/v1\noid sha256:abc\n"),
    };
    expect(() => parseOfflineSkill(b)).toThrow("LFS_POINTER_REJECTED");
  });
  it("indexes scripts as quarantined text without network or script execution", () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    try {
      const b = syntheticSkill();
      b.files.push({
        path: "scripts/never-run.py",
        kind: "file",
        bytes: Buffer.from("raise RuntimeError('NEVER EXECUTE')"),
      });
      const p = parseOfflineSkill(b);
      expect(p.resources.find((r) => r.path.startsWith("scripts/"))?.type).toBe(
        "SCRIPT_QUARANTINED",
      );
      expect(p.warnings).toContain("SCRIPTS_QUARANTINED");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
  it.each([
    `${base}\nname: synthetic-skill`,
    `${base}\nmetadata: &a {owner: x}`,
    `${base}\nmetadata: {owner: *a}`,
    `${base}\nmetadata: !!js/object {x: y}`,
    `${base}\nmetadata: {<<: {x: y}}`,
    `${base}\nmetadata: {__proto__: x}`,
    `${base}\nmetadata: {x: 12}`,
    `${base}\nmetadata: {x: !!str text}`,
    `${base}\nallowed-tools: [Bash]`,
    "name: Wrong_Name\ndescription: x",
    "name: synthetic--skill\ndescription: x",
    "name: different\ndescription: x",
    "name: synthetic-skill",
    `${base}\nmetadata: ${"[".repeat(25)}x${"]".repeat(25)}`,
    `${base}\nfuture: ${"[".repeat(10000)}x${"]".repeat(10000)}`,
    `${base}\n...\nname: other`,
  ])("rejects dangerous/malformed metadata case %#", rejects);
  it("requires main file, opening frontmatter, bounded names and descriptions", () => {
    const b = syntheticSkill();
    b.files[0].path = "other.md";
    expect(() => parseOfflineSkill(b)).toThrow("MAIN_REQUIRED");
    b.files[0].path = "SKILL.md";
    b.files[0].bytes = Buffer.from("# No header");
    expect(() => parseOfflineSkill(b)).toThrow("FRONTMATTER_REQUIRED");
    rejects(`name: synthetic-skill\ndescription: ${"x".repeat(1025)}`);
    rejects(`${base}\nlicense: false`);
    expect(parseOfflineSkill(syntheticSkill(base)).warnings).toContain("LICENSE_MISSING");
  });
  it("enforces file/count/main/total size limits", () => {
    const b = syntheticSkill();
    b.files[0].bytes = Buffer.alloc(SKILL_LIMITS.main + 1, 65);
    expect(() => parseOfflineSkill(b)).toThrow("MAIN_SIZE_LIMIT");
    b.files[0].bytes = Buffer.alloc(SKILL_LIMITS.resource + 1);
    expect(() => parseOfflineSkill(b)).toThrow("BUNDLE_SIZE_LIMIT");
    const c = syntheticSkill();
    c.files = Array.from({ length: 65 }, (_, i) => ({
      path: `${i}.md`,
      kind: "file",
      bytes: Buffer.from("x"),
    }));
    expect(() => parseOfflineSkill(c)).toThrow("BUNDLE_LIMIT_OR_SOURCE");
    c.files = Array.from({ length: 9 }, (_, i) => ({
      path: `${i}.md`,
      kind: "file",
      bytes: Buffer.alloc(SKILL_LIMITS.resource),
    }));
    expect(() => parseOfflineSkill(c)).toThrow("BUNDLE_SIZE_LIMIT");
  });
  it("verifies Git blob SHA1 separately from content SHA256", () => {
    const b = syntheticSkill();
    const f = b.files[0];
    f.gitBlobSha = createHash("sha1")
      .update(`blob ${f.bytes.length}\0`)
      .update(f.bytes)
      .digest("hex");
    expect(parseOfflineSkill(b).resources[0].gitBlobSha).toBe(f.gitBlobSha);
    f.gitBlobSha = "a".repeat(40);
    expect(() => parseOfflineSkill(b)).toThrow("GIT_BLOB_MISMATCH");
  });
  it("does not echo malicious source in errors", () => {
    try {
      parseOfflineSkill(syntheticSkill(`${base}\nmetadata: !!bad PRIVATE_SENTINEL`));
    } catch (e) {
      expect(String(e)).not.toContain("PRIVATE_SENTINEL");
    }
  });
});
