// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import release from "@/lib/server/skills/catalog/featured-20261105-01.json";
import { FeaturedSkillsPanel } from "./FeaturedSkillsPanel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("featured Skills disclosure", () => {
  it("shows three entries and expands the rest without reloading the publication", async () => {
    const publication = structuredClone(release);
    publication.repositories.push({ id: 999, fullName: "test/fourth" });
    publication.candidates.push({
      ...publication.candidates[0],
      id: "test-fourth",
      name: "Fourth candidate",
      repositoryId: 999,
    });
    publication.observations.push({
      ...publication.observations[0],
      repositoryId: 999,
      stars: 1,
      sourceUrl: "https://api.github.com/repos/test/fourth",
    });
    publication.orderedEntryIds.push("test-fourth");
    const fetchMock = vi.fn(async () => Response.json(publication));
    vi.stubEnv("NEXT_PUBLIC_PROMPTMASTER_DEMO_API_ENABLED", "true");
    vi.stubGlobal("fetch", fetchMock);
    render(<FeaturedSkillsPanel locale="en" />);
    await waitFor(() => expect(screen.getByText("View all 4 Skills")).toBeTruthy());
    expect(screen.getByRole("region").querySelectorAll(":scope > ol > li")).toHaveLength(3);
    expect(screen.getByRole("heading", { name: "Fourth candidate" })).not.toBeVisible();
    const summary = screen.getByText("View all 4 Skills");
    expect(summary.closest("details")!.open).toBe(false);
    fireEvent.click(summary);
    expect(screen.getByRole("heading", { name: "Fourth candidate" })).toBeVisible();
    fireEvent.click(summary);
    expect(screen.getByRole("heading", { name: "Fourth candidate" })).not.toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves the original publication when a reload fails", async () => {
    vi.stubEnv("NEXT_PUBLIC_PROMPTMASTER_DEMO_API_ENABLED", "true");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(release))
      .mockResolvedValueOnce(Response.json({ error: "UNAVAILABLE" }, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<FeaturedSkillsPanel locale="en" />);
    await waitFor(() => expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(3));
    fireEvent.click(screen.getByRole("button", { name: "Reload saved list" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Keeping the previously loaded publication",
      ),
    );
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(3);
    fireEvent.click(screen.getByText("View details · brainstorming"));
    expect(screen.getByText(`${release.observations[0].observedAt} (UTC)`)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
