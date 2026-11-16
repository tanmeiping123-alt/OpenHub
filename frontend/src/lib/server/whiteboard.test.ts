import { describe, expect, it } from "vitest";
import { parseWhiteboard, verifyWhiteboardOwner } from "./whiteboard";
import { accountContext } from "./identity-context";

const draft = () => ({
  ownerId: "user-a",
  revision: 0,
  scene: {
    elements: [{ id: "sticky", type: "stickynote", x: 0, y: 0, width: 100, height: 100 }],
    appState: {},
    files: {},
  },
  libraryItems: [],
});
describe("private whiteboard input", () => {
  it("accepts supported scenes including sticky notes", () => {
    expect(parseWhiteboard(draft()).scene.elements).toHaveLength(1);
  });
  it.each([
    { visibility: "PUBLIC" },
    { ownerId: 42 },
    { revision: -1 },
    { revision: 1.5 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { libraryItems: {} },
    {
      scene: {
        elements: [],
        appState: {},
        files: {
          external: {
            id: "external",
            mimeType: "image/png",
            dataURL: "https://example.test/private.png",
            created: 1,
          },
        },
      },
    },
    {
      scene: {
        elements: [{ id: "bad", type: "unknown", x: 0, y: 0, width: 1, height: 1 }],
        appState: {},
        files: {},
      },
    },
    {
      scene: {
        elements: [{ id: "bad", type: "rectangle", x: Infinity, y: 0, width: 1, height: 1 }],
        appState: {},
        files: {},
      },
    },
    { libraryItems: [{ id: "library", status: "unpublished", created: 1, elements: "bad" }] },
  ])("rejects malformed or public input %#", (override) => {
    expect(() => parseWhiteboard({ ...draft(), ...override })).toThrow("INVALID_WHITEBOARD");
  });
  it("always derives ownership from the session, including administrators", () => {
    expect(() => verifyWhiteboardOwner(null)).toThrow("AUTH_REQUIRED");
    accountContext.run({ id: "admin-a", role: "ADMIN", email: "admin@example.test" }, () => {
      expect(verifyWhiteboardOwner(null)).toBe("admin-a");
      expect(() => verifyWhiteboardOwner("user-a")).toThrow("WHITEBOARD_ACCOUNT_CHANGED");
    });
  });
});
