import { describe, expect, it } from "vitest";
import {
  publication,
  listQuery,
  fingerprint,
  requestKey,
  starInput,
  moderationPages,
} from "./validation";

export const input = {
  title: "A clear prompt",
  summary: "Useful example",
  content: "Exact content\n",
  taskType: "Writing",
  language: "en",
  tags: ["example"],
  variables: "",
  modelNotes: "",
  exampleInput: "",
  exampleOutput: "",
  usageNotes: "",
  changeNote: "",
  authorName: "Public writer",
  authorBio: "Public bio",
  consent: true,
};
describe("community validation", () => {
  it("supports optional multi-purpose publishing and normalized tags without adding mandatory fields", () => {
    expect(
      publication({ ...input, purposes: ["analyze", "create"], tags: ["写文案", "文案写作"] }),
    ).toMatchObject({ purposes: ["analyze", "create"], tags: ["文案写作"] });
    expect(publication({ ...input, purposes: [] }).purposes).toEqual([]);
    expect(publication(input).purposes).toBeUndefined();
    expect(() => publication({ ...input, purposes: ["bad"] })).toThrow("INVALID_INPUT");
    expect(() => publication({ ...input, tags: ["https://spam.test"] })).toThrow("INVALID_INPUT");
  });
  it("defaults keyword search to relevance and combines purpose and tag filters", () => {
    expect(listQuery(new URLSearchParams("q=简历修改&purpose=improve&tag=简历修改"))).toMatchObject(
      { sort: "relevance", purpose: "improve", tag: "简历优化" },
    );
    expect(listQuery(new URLSearchParams()).sort).toBe("stars");
    expect(listQuery(new URLSearchParams("q=resume&sort=stars")).sort).toBe("stars");
    expect(() => listQuery(new URLSearchParams("purpose=unknown"))).toThrow("INVALID_INPUT");
    expect(() => listQuery(new URLSearchParams("tag=x&tag=y"))).toThrow("INVALID_INPUT");
  });
  it("validates independent moderation pages as bounded positive integers", () => {
    expect(moderationPages(new URLSearchParams())).toEqual({
      reportsPage: 1,
      starsPage: 1,
      eventsPage: 1,
    });
    expect(moderationPages(new URLSearchParams("reportsPage=2&starsPage=3&eventsPage=4"))).toEqual({
      reportsPage: 2,
      starsPage: 3,
      eventsPage: 4,
    });
    for (const invalid of ["0", "-1", "1.5", "Infinity", "1000001", "", "1e2"])
      expect(() => moderationPages(new URLSearchParams(`reportsPage=${invalid}`))).toThrow(
        "INVALID_INPUT",
      );
  });
  it("requires explicit CC0 consent and rejects unknown private fields", () => {
    expect(() => publication({ ...input, consent: false })).toThrow("CONSENT_REQUIRED");
    expect(() => publication({ ...input, ownerId: "secret" })).toThrow("INVALID_INPUT");
    expect(publication(input).content).toBe(input.content);
  });
  it("requires a base version, change note and explicit consent for updates", () => {
    expect(() => publication(input, true)).toThrow("VERSION_REQUIRED");
    expect(() =>
      publication({ ...input, baseVersion: 1, changeNote: "Improved", consent: false }, true),
    ).toThrow("CONSENT_REQUIRED");
    expect(
      publication({ ...input, baseVersion: 1, changeNote: "Improved", consent: true }, true)
        .baseVersion,
    ).toBe(1);
    expect(() => publication({ ...input, authorName: "private@example.test" })).toThrow(
      "PUBLIC_AUTHOR_NAME_EMAIL_REJECTED",
    );
  });
  it("bounds all user inputs and requires exact source pairs", () => {
    for (const patch of [
      { content: " " },
      { title: "x".repeat(241) },
      { language: "bad" },
      { tags: Array(13).fill("x") },
      { sourcePublicId: "pub_bad" },
    ]) {
      expect(() => publication({ ...input, ...patch })).toThrow();
    }
  });
  it("uses a canonical fingerprint across key order", () => {
    expect(fingerprint({ a: 1, b: { c: 2, d: 3 } })).toBe(fingerprint({ b: { d: 3, c: 2 }, a: 1 }));
    expect(fingerprint(input)).not.toBe(fingerprint({ ...input, content: "changed" }));
  });
  it("validates page, filters and explicit star state", () => {
    expect(listQuery(new URLSearchParams()).page).toBe(1);
    expect(() => listQuery(new URLSearchParams("page=-1"))).toThrow();
    expect(() => listQuery(new URLSearchParams("sort=random"))).toThrow();
    expect(() => listQuery(new URLSearchParams("q=" + "x".repeat(201)))).toThrow();
    expect(() => starInput({ active: "true", versionNumber: 1 })).toThrow();
    expect(starInput({ active: false, versionNumber: 2 })).toEqual({
      active: false,
      versionNumber: 2,
    });
    expect(() => requestKey(null)).toThrow("IDEMPOTENCY_KEY_REQUIRED");
  });
});
