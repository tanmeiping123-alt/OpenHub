// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AdminAccountsPanel } from "./AdminAccountsPanel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("loads account tables only for an authenticated administrator", async () => {
  const fetchMock = vi.fn(async (path: string) =>
    Response.json(
      path === "/api/auth/session"
        ? { user: { role: "ADMIN" } }
        : {
            administrators: [{ id: "admin", email: "admin@example.test", disabled: false }],
            users: [{ id: "user", email: "user@example.test", disabled: true }],
          },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<AdminAccountsPanel locale="en" />);
  fireEvent.click(await screen.findByText("Account management"));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Load account tables" }));
  expect(await screen.findByText("admin@example.test")).toBeVisible();
  expect(screen.getByText("user@example.test")).toBeVisible();
  expect(screen.getByText("Disabled")).toBeVisible();
});

it.each(["USER", null])("does not expose account data to role %s", async (role) => {
  const fetchMock = vi.fn<(path: string) => Promise<Response>>(async () =>
    Response.json({ user: role ? { role } : null }),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<AdminAccountsPanel locale="en" />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(screen.queryByText("Account management")).toBeNull();
  expect(fetchMock.mock.calls.some(([path]) => path === "/api/accounts")).toBe(false);
});
