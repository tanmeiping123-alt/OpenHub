// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInitialState } from "@/lib/fixtures";
import { reducer, useAppStore } from "@/lib/store";
import type { Action, AppState } from "@/lib/types";
import { DraftEditor } from "./DraftEditor";

vi.mock("@/lib/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/store")>()),
  useAppStore: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const originalDraft: AppState["draft"] = {
  title: "Saved title",
  content: "Saved body",
  taskType: "Writing",
  promptId: "prm_saved",
  parentVersionId: "ver_saved",
  savedCreation: { promptId: "prm_saved", versionId: "ver_saved" },
  adoptedUseEventIds: ["use_saved"],
};

function Harness({ draft = originalDraft }: { draft?: AppState["draft"] }) {
  const [state, setState] = useState<AppState>(() => ({ ...createInitialState(), draft }));
  const dispatch = async (action: Action) => {
    setState((current) => {
      const next = reducer(current, action);
      if (action.type === "CREATE_MANUAL_PROMPT") {
        next.draft.savedCreation = {
          promptId: next.draft.promptId!,
          versionId: next.draft.parentVersionId!,
        };
      }
      return next;
    });
    return "session" as const;
  };
  vi.mocked(useAppStore).mockReturnValue({ state, dispatch, accountId: "user-test" });
  return (
    <>
      <DraftEditor locale="en" />
      <output data-testid="draft-state">{JSON.stringify(state.draft)}</output>
    </>
  );
}

describe("new draft after saving", () => {
  it.each([undefined, { purposes: ["plan" as const], tags: ["Original"] }])(
    "reconciles the original descriptor without reclassifying a pending request (%j)",
    async (descriptor) => {
      const dispatch = vi.fn(async () => "unavailable" as const);
      const state = {
        ...createInitialState(),
        draft: {
          title: "Analyze data",
          content: "Analyze sales data",
          taskType: "General" as const,
          promptId: null,
          descriptor: { purposes: ["create" as const], tags: ["Changed"] },
          creationRequest: {
            key: "original-request",
            title: "Analyze data",
            content: "Analyze sales data",
            taskType: "General" as const,
            manualDraft: true,
            ...(descriptor === undefined ? {} : { descriptor }),
          },
        },
      };
      vi.mocked(useAppStore).mockReturnValue({ state, dispatch, accountId: "user-test" });
      render(<DraftEditor locale="en" />);
      fireEvent.click(screen.getByRole("button", { name: "Reconcile this save" }));
      await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
      expect(dispatch.mock.calls[0]).toEqual([
        {
          type: "CREATE_MANUAL_PROMPT",
          title: "Analyze data",
          content: "Analyze sales data",
          taskType: "General",
          descriptor,
        },
      ]);
    },
  );

  it("starts a clean draft, focuses the title, and allows another save", async () => {
    render(<Harness />);
    expect(screen.getByLabelText("Prompt title")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Write another Prompt" }));
    await waitFor(() => expect(screen.getByLabelText("Prompt title")).toBeEnabled());
    expect(screen.getByLabelText("Prompt title")).toHaveValue("");
    expect(screen.getByLabelText("Prompt content")).toHaveValue("");
    await waitFor(() => expect(screen.getByLabelText("Prompt title")).toHaveFocus());
    const fresh = JSON.parse(screen.getByTestId("draft-state").textContent!);
    expect(fresh).toEqual({ title: "", content: "", taskType: "Writing", promptId: null });
    fireEvent.change(screen.getByLabelText("Prompt title"), { target: { value: "Second title" } });
    fireEvent.change(screen.getByLabelText("Prompt content"), { target: { value: "Second body" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as new Prompt" }));
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Open saved Prompt" })).toBeVisible(),
    );
    expect(screen.getByLabelText("Prompt content")).toHaveValue("Second body");
    fireEvent.click(screen.getByRole("button", { name: "Write another Prompt" }));
    await waitFor(() => expect(screen.getByLabelText("Prompt title")).toHaveFocus());
    expect(screen.getByLabelText("Prompt content")).toHaveValue("");
  });

  it("does not offer a reset while a save result is unknown", () => {
    const pending: AppState["draft"] = {
      ...originalDraft,
      savedCreation: undefined,
      creationRequest: {
        key: "same-request",
        title: "Saved title",
        content: "Saved body",
        taskType: "Writing",
        manualDraft: true,
      },
    };
    render(<Harness draft={pending} />);
    expect(screen.queryByRole("button", { name: "Write another Prompt" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reconcile this save" })).toBeEnabled();
    expect(screen.getByLabelText("Prompt content")).toBeDisabled();
    expect(JSON.parse(screen.getByTestId("draft-state").textContent!).creationRequest).toEqual(
      pending.creationRequest,
    );
  });

  it("blocks reset when a pending request coexists with a saved marker", () => {
    const pending = {
      ...originalDraft,
      creationRequest: {
        key: "same-request",
        title: "Saved title",
        content: "Saved body",
        taskType: "Writing" as const,
        manualDraft: true,
      },
    };
    render(<Harness draft={pending} />);
    const reset = screen.getByRole("button", { name: "Write another Prompt" });
    expect(reset).toBeDisabled();
    fireEvent.click(reset);
    expect(screen.getByLabelText("Prompt content")).toHaveValue("Saved body");
    expect(JSON.parse(screen.getByTestId("draft-state").textContent!).creationRequest).toEqual(
      pending.creationRequest,
    );
  });

  it("waits for the save operation to finish before enabling another draft", async () => {
    let finish!: (value: "session") => void;
    const dispatch = vi.fn(
      () =>
        new Promise<"session">((resolve) => {
          finish = resolve;
        }),
    );
    const state = {
      ...createInitialState(),
      draft: { ...originalDraft, savedCreation: undefined },
    };
    vi.mocked(useAppStore).mockReturnValue({ state, dispatch, accountId: "user-test" });
    const view = render(<DraftEditor locale="en" />);
    fireEvent.click(screen.getByRole("button", { name: "Save as new Prompt" }));
    vi.mocked(useAppStore).mockReturnValue({
      state: { ...state, draft: originalDraft },
      dispatch,
      accountId: "user-test",
    });
    view.rerender(<DraftEditor locale="en" />);
    const reset = screen.getByRole("button", { name: "Write another Prompt" });
    expect(reset).toBeDisabled();
    fireEvent.click(reset);
    expect(dispatch).toHaveBeenCalledTimes(1);
    await act(async () => finish("session"));
    expect(reset).toBeEnabled();
  });
});
