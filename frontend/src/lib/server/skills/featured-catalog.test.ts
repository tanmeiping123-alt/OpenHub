import { expect, it, vi } from "vitest";
import { getFeaturedPublication } from "./featured-catalog";

it("returns a complete validated clone, without DB, network or private owner state", () => {
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("NO_NETWORK"));
  try {
    const first = getFeaturedPublication();
    const id = first.orderedEntryIds[0];
    first.orderedEntryIds.reverse();
    first.candidates[0].name = "mutated";
    const next = getFeaturedPublication();
    expect(next.orderedEntryIds[0]).toBe(id);
    expect(next.candidates[0].name).toBe("brainstorming");
    expect(JSON.stringify(next)).not.toMatch(/ownerId|enabled|reviewerId|apiKey/);
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
  }
});
