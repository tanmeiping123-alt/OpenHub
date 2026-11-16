// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SkillLibraryPanel } from "./SkillLibraryPanel";
import { SkillImportPanel } from "./SkillImportPanel";

const { push, dispatch } = vi.hoisted(() => ({ push: vi.fn(), dispatch: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/store", () => ({
  useAppStore: () => ({ state: { draft: { content: "Existing text" } }, dispatch }),
}));
const source = {
  repositoryOwner: "example",
  repositoryName: "methods",
  path: "skills/writing",
  ref: "a".repeat(40),
};
const skill = {
  versionId: "skv_example",
  name: "Writing",
  description: "Write clearly",
  source,
  manifestSha256: "b".repeat(64),
  warnings: [],
  publicationKind: null,
  submissionId: null,
  submissionStatus: "PENDING",
  reviewNote: null,
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  push.mockReset();
  dispatch.mockReset();
});

it("selects a version for the current task without inserting its body", async () => {
  const fetchMock = vi.fn<(path: string, options?: RequestInit) => Promise<Response>>(async () =>
    Response.json({
      user: { id: "usr", email: "me@example.test", role: "USER" },
      library: [],
      personal: [skill],
      pending: [],
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<SkillLibraryPanel locale="en" mode="simple" />);
  fireEvent.click(await screen.findByRole("button", { name: "My imports (1)" }));
  fireEvent.click(screen.getByRole("button", { name: "Use for this generation / optimization" }));
  expect(push).toHaveBeenCalledWith("/en/app/generate?skillVersion=skv_example");
  expect(dispatch).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls.every((args) => !(args[1] as RequestInit | undefined)?.method)).toBe(
    true,
  );
  expect(screen.getByText("Only you can use this version")).toBeVisible();
  expect(screen.getByText("Recommendation pending review")).toBeVisible();
  expect(screen.queryByText("Account management")).toBeNull();
  expect(screen.queryByText("Import a Skill from GitHub")).toBeNull();
});

it.each([
  [
    "/en/app/prompts/prm_current-01/optimize",
    "/en/app/prompts/prm_current-01/optimize?skillVersion=skv_example",
  ],
  [
    "https://outside.example/app/prompts/prm_current/optimize",
    "/en/app/generate?skillVersion=skv_example",
  ],
  [
    "//outside.example/en/app/prompts/prm_current/optimize",
    "/en/app/generate?skillVersion=skv_example",
  ],
  ["/zh-CN/app/prompts/prm_current/optimize", "/en/app/generate?skillVersion=skv_example"],
  ["/en/app/prompts/prm_current/optimize?unsafe=1", "/en/app/generate?skillVersion=skv_example"],
])("returns to the allowed current optimization task for %s", async (taskReturn, destination) => {
  window.history.replaceState(
    null,
    "",
    `/en/app/skills?taskReturn=${encodeURIComponent(taskReturn)}`,
  );
  const fetchMock = vi.fn<(path: string, options?: RequestInit) => Promise<Response>>(async () =>
    Response.json({
      user: { id: "usr", role: "USER" },
      library: [],
      personal: [skill],
      pending: [],
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<SkillLibraryPanel locale="en" mode="simple" />);
  fireEvent.click(await screen.findByRole("button", { name: "My imports (1)" }));
  fireEvent.click(screen.getByRole("button", { name: "Use for this generation / optimization" }));
  expect(push).toHaveBeenCalledWith(destination);
  expect(dispatch).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls.every((args) => !args[1]?.method)).toBe(true);
});

it("previews a unique GitHub candidate directly and imports only after consent", async () => {
  const fetchMock = vi.fn(async (path: string) =>
    Response.json(
      path.endsWith("discover")
        ? { candidates: [source] }
        : path.endsWith("sources")
          ? {
              preparedSourceId: "prepared",
              source,
              preview: {
                name: "Writing",
                description: "Write clearly",
                body: "Exact source body",
                warnings: [],
                resources: [],
              },
            }
          : { status: "REGISTERED", versionId: "skv_example" },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<SkillImportPanel locale="en" role="USER" userId="usr" onImported={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("GitHub repository or Skill directory URL"), {
    target: { value: "https://github.com/example/methods" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview source" }));
  await screen.findByText("Exact source body");
  expect(screen.queryByRole("button", { name: "Preview: skills/writing" })).toBeNull();
  const confirm = screen.getByRole("button", { name: "Import for personal use" });
  expect(confirm).toBeDisabled();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("checkbox", { name: /I have permission/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: /I accept personal-use risks/ }));
  fireEvent.click(confirm);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Imported. Only you can use this version; sharing requires a separate recommendation.",
    ),
  );
});

it("requires choosing a candidate only when discovery finds several", async () => {
  const fetchMock = vi.fn(async () =>
    Response.json({ candidates: [source, { ...source, path: "skills/review" }] }),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<SkillImportPanel locale="en" role="USER" userId="usr" onImported={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("GitHub repository or Skill directory URL"), {
    target: { value: "https://github.com/example/methods" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview source" }));
  expect(await screen.findByRole("button", { name: "Preview: skills/writing" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Preview: skills/review" })).toBeVisible();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("restores the same pending import request for this account", async () => {
  sessionStorage.setItem(
    "pm-skill-import:usr",
    JSON.stringify({
      key: "saved-key",
      path: "/api/skills/imports",
      body: { preparedSourceId: "saved-preview" },
    }),
  );
  const onPending = vi.fn();
  const fetchMock = vi.fn<(path: string, options?: RequestInit) => Promise<Response>>(async () =>
    Response.json({ status: "REGISTERED", versionId: "skv_example" }),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(
    <SkillImportPanel
      locale="en"
      role="USER"
      userId="usr"
      onImported={vi.fn()}
      onPending={onPending}
    />,
  );
  expect(onPending).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Reconcile guided import" }));
  await screen.findByRole("status");
  const [path, options] = fetchMock.mock.calls[0];
  expect(path).toBe("/api/skills/imports");
  expect(options?.headers).toMatchObject({ "Idempotency-Key": "saved-key" });
  expect(JSON.parse(String(options?.body))).toEqual({ preparedSourceId: "saved-preview" });
  expect(sessionStorage.getItem("pm-skill-import:usr")).toBeNull();
});

it("recovers a legacy account-scoped import without changing its request key or source", async () => {
  sessionStorage.setItem(
    "pm-skill-library-import:usr",
    JSON.stringify({
      key: "legacy-key",
      source: JSON.stringify(source),
      preparedSourceId: "legacy-preview",
    }),
  );
  const fetchMock = vi.fn<(path: string, options?: RequestInit) => Promise<Response>>(async () =>
    Response.json({ status: "REGISTERED", reusedVersion: true }),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<SkillImportPanel locale="en" role="USER" userId="usr" onImported={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Reconcile guided import" }));
  await screen.findByRole("status");
  expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ "Idempotency-Key": "legacy-key" });
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
    preparedSourceId: "legacy-preview",
  });
  expect(sessionStorage.getItem("pm-skill-library-import:usr")).toBeNull();
});

it("keeps a successful import's scope when list refresh fails", async () => {
  sessionStorage.setItem(
    "pm-skill-import:usr",
    JSON.stringify({ key: "saved-key", path: "/api/skills/offline", body: { files: [] } }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ status: "REGISTERED" })),
  );
  render(
    <SkillImportPanel
      locale="en"
      role="ADMIN"
      userId="usr"
      onImported={vi.fn(async () => {
        throw Error("refresh");
      })}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Reconcile guided import" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Published to the shared library for all users. List refresh failed",
    ),
  );
});

it("resets the authorization when a preview expires and requires new source review", async () => {
  sessionStorage.setItem(
    "pm-skill-import:usr",
    JSON.stringify({
      key: "saved-key",
      path: "/api/skills/imports",
      body: { preparedSourceId: "expired" },
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ error: "PREPARED_SOURCE_EXPIRED_OR_NOT_FOUND" }, { status: 400 }),
    ),
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  render(<SkillImportPanel locale="en" role="USER" userId="usr" onImported={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Reconcile guided import" }));
  fireEvent.click(await screen.findByRole("button", { name: "Identify source again" }));
  expect(screen.getByRole("button", { name: "Import for personal use" })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: /I have permission/ })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: /I accept personal-use risks/ })).not.toBeChecked();
  expect(sessionStorage.getItem("pm-skill-import:usr")).toBeNull();
});

it.each(["SAME_VERSION", "NEW_VERSION"])(
  "explains %s before saving a GitHub version",
  async (importState) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) =>
        Response.json(
          path.endsWith("discover")
            ? { candidates: [source] }
            : {
                preparedSourceId: "prepared",
                source,
                preview: {
                  name: "Writing",
                  description: "Write clearly",
                  body: "Exact source body",
                  warnings: [],
                  resources: [],
                  importState,
                },
              },
        ),
      ),
    );
    render(<SkillImportPanel locale="en" role="USER" userId="usr" onImported={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("GitHub repository or Skill directory URL"), {
      target: { value: "https://github.com/example/methods" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview source" }));
    await screen.findByText("Exact source body");
    if (importState === "SAME_VERSION") {
      expect(
        screen.getByText(
          "This exact version already exists. No duplicate import is needed; check its current availability in your library.",
        ),
      ).toBeVisible();
      expect(screen.getByRole("button", { name: "Already imported" })).toBeDisabled();
    } else {
      expect(
        screen.getByText(
          "This source has changed. Save a separate version after review; previous sharing approval does not apply to the new version.",
        ),
      ).toBeVisible();
      fireEvent.click(screen.getByRole("checkbox", { name: /I have permission/ }));
      fireEvent.click(screen.getByRole("checkbox", { name: /I accept personal-use risks/ }));
      expect(screen.getByRole("button", { name: "Import for personal use" })).toBeDisabled();
      fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed the version change/ }));
      expect(screen.getByRole("button", { name: "Import for personal use" })).toBeEnabled();
    }
  },
);

it("reconciles a reused version without claiming it was newly published", async () => {
  sessionStorage.setItem(
    "pm-skill-import:usr",
    JSON.stringify({
      key: "saved-key",
      path: "/api/skills/imports",
      body: { preparedSourceId: "old-preview" },
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ status: "REGISTERED", reusedVersion: true })),
  );
  render(<SkillImportPanel locale="en" role="ADMIN" userId="usr" onImported={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Reconcile guided import" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "This version already exists; no duplicate version was created. Check its current availability in the library.",
    ),
  );
});
