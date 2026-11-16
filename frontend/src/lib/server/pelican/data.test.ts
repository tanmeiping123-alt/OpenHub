import { describe, expect, it } from "vitest";
import { pelicanHash } from "./policy";

describe("Pelican evidence fingerprints", () => {
  it("hashes nested JSON objects identically across database key ordering", () => {
    expect(
      pelicanHash({
        batchId: "b",
        config: { provider: "deepseek", tokens: 128 },
        samples: [{ id: "a", config: { maxRetries: 0, strength: "off" } }],
      }),
    ).toBe(
      pelicanHash({
        samples: [{ config: { strength: "off", maxRetries: 0 }, id: "a" }],
        config: { tokens: 128, provider: "deepseek" },
        batchId: "b",
      }),
    );
    expect(pelicanHash({ samples: ["a", "b"] })).not.toBe(pelicanHash({ samples: ["b", "a"] }));
  });
});
