"use client";

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createInitialState,
  layerDefaults,
  localizedContentFor,
  localizedTitleFor,
  reports,
} from "./fixtures";
import type { Action, AppState, EvaluationReport } from "./types";
import { createCalibrationReport, validateCalibrationReport } from "./calibration";
import { fetchRemoteSnapshot, isRemoteDemoSyncEnabled, mutateRemoteDemo } from "./api-client";
import { isWorkspacePath, loginDestination } from "./auth-navigation";
import { usePathname } from "next/navigation";
import { hasUnsavedDraft } from "./prompt-navigation";

type PersistenceResult = "database" | "session" | "unavailable" | "database-refresh-pending";
type AppDispatch = (action: Action) => Promise<PersistenceResult>;

const StoreContext = createContext<{
  state: AppState;
  dispatch: AppDispatch;
  accountId: string | null;
} | null>(null);
const storageKey = "promptmaster-demo-v1";
const restoreFailure =
  "This account's cached data could not be restored; saved records will be reloaded.";
function emptyWorkspace(): Partial<AppState> {
  return {
    prompts: [],
    versions: [],
    reports: [],
    history: [],
    libraryPromptIds: [],
    favorites: [],
    playgroundRuns: [],
    liveAdvice: [],
    suggestions: [],
    profileName: "",
    draft: { promptId: null, title: "", content: "", taskType: "Writing" },
  };
}

function restoreState(state: AppState, saved: Partial<AppState>): AppState | null {
  try {
    const prompts = saved.prompts ?? state.prompts;
    const versions = saved.versions ?? state.versions;
    const reports = saved.reports ?? state.reports;
    const history = saved.history ?? state.history;
    if (![prompts, versions, reports, history].every(Array.isArray)) return null;
    if (
      ![prompts, versions, reports, history].every(
        (items) =>
          items.every((item) => item && typeof item.id === "string") &&
          new Set(items.map((item) => item.id)).size === items.length,
      )
    )
      return null;
    if (
      !versions.every(
        (v) => typeof v.content === "string" && prompts.some((p) => p.id === v.promptId),
      )
    )
      return null;
    if (
      !prompts.every((p) =>
        versions.some((v) => v.id === p.currentVersionId && v.promptId === p.id),
      )
    )
      return null;
    if (
      !history.every((h) => versions.some((v) => v.id === h.versionId && v.promptId === h.promptId))
    )
      return null;
    if (
      !reports.every((r) => {
        const v = versions.find((v) => v.id === r.versionId && v.promptId === r.promptId);
        return (
          v &&
          [r.layer1, r.layer2, r.layer3].every(
            (l) => l && typeof l.status === "string" && Array.isArray(l.dimensions),
          ) &&
          (r.source !== "LOCAL_HUMAN_CALIBRATION" || validateCalibrationReport(r, v))
        );
      })
    )
      return null;
    if (
      saved.draft &&
      (typeof saved.draft.content !== "string" ||
        (saved.draft.parentVersionId &&
          !versions.some(
            (v) => v.id === saved.draft!.parentVersionId && v.promptId === saved.draft!.promptId,
          )))
    )
      return null;
    return {
      ...state,
      prompts,
      versions,
      reports,
      history,
      libraryPromptIds: saved.libraryPromptIds ?? state.libraryPromptIds,
      favorites: saved.favorites ?? state.favorites,
      draft: saved.draft ?? state.draft,
      suggestions: saved.suggestions ?? state.suggestions,
      playgroundRuns: saved.playgroundRuns ?? state.playgroundRuns,
      liveAdvice: saved.liveAdvice ?? state.liveAdvice,
      profileName: saved.profileName ?? state.profileName,
    };
  } catch {
    return null;
  }
}

function makeReport(state: AppState, promptId: string, versionId: string): EvaluationReport {
  const prompt = state.prompts.find((item) => item.id === promptId)!;
  const fixed = reports.find(
    (report) => report.promptId === promptId && report.versionId === versionId,
  );
  if (fixed)
    return {
      ...structuredClone(fixed),
      id: `evr_demo_${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
    };
  const dims = [
    "Goal Clarity",
    "Context Completeness",
    "Instruction Structure",
    "Constraints & Boundaries",
    "Output Specification",
    "Precision & Verifiability",
  ];
  const candidate = ["Data Analysis", "Business", "Research", "AI Agent"].includes(prompt.taskType);
  const layer2 =
    prompt.taskType === "General"
      ? layerDefaults().unavailable
      : candidate
        ? { status: "PENDING REVIEW", score: null, grade: null, dimensions: [] }
        : {
            status: "MOCK / SIMULATED",
            score: null,
            grade: null,
            dimensions: [
              {
                name: prompt.taskType,
                weight: 0,
                score: null,
                state: "QUALITATIVE MOCK",
                reason: "This prototype does not calculate an official task-specific score.",
              },
            ],
          };
  return {
    id: `evr_demo_${crypto.randomUUID()}`,
    promptId,
    versionId,
    createdAt: new Date().toISOString().slice(0, 10),
    source: "MOCK / SIMULATED",
    rubricVersion: candidate
      ? `${prompt.taskType} rubric pending category review`
      : "Illustrative qualitative fixture; no formal formula",
    layer1: {
      status: "INSUFFICIENT_INFORMATION",
      score: null,
      grade: null,
      dimensions: dims.map((name) => ({
        name,
        weight: [20, 20, 15, 15, 15, 15][dims.indexOf(name)],
        score: null,
        state: "INSUFFICIENT_INFORMATION",
        reason: "No approved runtime scoring formula is active for this ad hoc draft.",
      })),
    },
    layer2,
    layer3: layerDefaults().notExecuted,
  };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "SET_LOCALE":
      return { ...state, locale: action.locale };
    case "SET_MODE":
      return {
        ...state,
        mode: action.mode,
        notice: `Mode changed to ${action.mode === "simple" ? "Simple" : "Professional"} · demo`,
      };
    case "SET_TIER":
      return {
        ...state,
        tier: action.tier,
        notice: `${action.tier} demo scenario selected; permissions remain TBD.`,
      };
    case "SET_DRAFT":
      return { ...state, draft: { ...state.draft, ...action.patch } };
    case "LOAD_PROMPT": {
      const prompt = state.prompts.find((item) => item.id === action.promptId);
      const version = state.versions.find((item) => item.id === prompt?.currentVersionId);
      return prompt && version
        ? {
            ...state,
            draft: {
              promptId: prompt.id,
              title: localizedTitleFor(prompt.id, state.locale, prompt.title),
              taskType: prompt.taskType,
              descriptor: prompt.descriptor,
              content: localizedContentFor(version.id, state.locale, version.content),
              parentVersionId: version.id,
            },
            notice: null,
          }
        : { ...state, notice: "Demo prompt not found." };
    }
    case "GENERATE":
    case "CREATE_MANUAL_PROMPT": {
      const id = `prm_demo_${Date.now()}`;
      const versionId = `ver_demo_${Date.now()}`;
      const version = {
        id: versionId,
        promptId: id,
        number: 1,
        title: action.title,
        content: action.content,
        createdBy: "demo",
        source: action.type === "CREATE_MANUAL_PROMPT" ? "MANUAL_DRAFT" : "Generated · simulated",
        createdAt: new Date().toISOString().slice(0, 10),
      };
      const prompt = {
        id,
        title: action.title,
        taskType: action.taskType,
        ...(action.descriptor ? { descriptor: action.descriptor } : {}),
        currentVersionId: versionId,
        kind: "PERSONAL_PROMPT" as const,
        description:
          action.type === "CREATE_MANUAL_PROMPT"
            ? "Manually saved draft."
            : "Generated locally for this demo.",
        favorite: false,
      };
      return {
        ...state,
        prompts: [prompt, ...state.prompts],
        versions: [version, ...state.versions],
        draft: {
          promptId: id,
          title: action.title,
          content: action.content,
          taskType: action.taskType,
          parentVersionId: versionId,
          descriptor: action.descriptor,
        },
        history: [
          {
            id: `his_${Date.now()}`,
            promptId: id,
            versionId,
            source: version.source,
            createdAt: version.createdAt,
          },
          ...state.history,
        ],
        notice:
          action.type === "CREATE_MANUAL_PROMPT"
            ? "Draft saved; no model was called."
            : "Prompt generated · Mock / Simulated",
      };
    }
    case "SAVE_VERSION": {
      const promptId = action.promptId ?? state.draft.promptId;
      if (!promptId) return { ...state, notice: "Generate a Prompt before saving a version." };
      const prior = state.versions
        .filter((item) => item.promptId === promptId)
        .sort((a, b) => b.number - a.number)[0];
      const prompt = state.prompts.find((item) => item.id === promptId);
      if (!prior || !prompt)
        return { ...state, notice: "Demo save failed; existing content is preserved." };
      if (
        action.optimizationId &&
        (action.content ?? state.draft.content) === prior.content &&
        (action.descriptor === undefined ||
          JSON.stringify(action.descriptor) === JSON.stringify(prompt.descriptor))
      )
        return { ...state, notice: "The current expression is already clear; no changes to save." };
      const id = `ver_demo_${Date.now()}`;
      const createdAt = new Date().toISOString().slice(0, 10);
      const version = {
        id,
        promptId,
        number: prior.number + 1,
        title:
          action.title ?? (state.draft.promptId === promptId ? state.draft.title : prompt.title),
        content: action.content ?? state.draft.content,
        createdBy: "demo",
        source: action.source,
        createdAt,
        parentVersionId:
          action.parentVersionId ??
          (state.draft.promptId === promptId ? state.draft.parentVersionId : undefined) ??
          prior.id,
      };
      return {
        ...state,
        versions: [version, ...state.versions],
        prompts: state.prompts.map((item) =>
          item.id === promptId
            ? {
                ...item,
                currentVersionId: id,
                title: version.title,
                ...(action.descriptor === undefined ? {} : { descriptor: action.descriptor }),
              }
            : item,
        ),
        history: [
          { id: `his_${Date.now()}`, promptId, versionId: id, source: action.source, createdAt },
          ...state.history,
        ],
        draft:
          action.optimizationId && hasUnsavedDraft(state, state.locale)
            ? state.draft
            : {
                promptId,
                title: version.title,
                taskType: prompt.taskType,
                parentVersionId: id,
                content: version.content,
                descriptor: action.descriptor ?? prompt.descriptor,
              },
        notice: "New Prompt version saved · Mock / Simulated",
      };
    }
    case "RESTORE_VERSION": {
      const source = state.versions.find((item) => item.id === action.versionId);
      if (!source || source.promptId !== action.promptId)
        return { ...state, notice: "Restore failed; history is unchanged." };
      const prompt = state.prompts.find((item) => item.id === action.promptId)!;
      const latest = state.versions
        .filter((item) => item.promptId === prompt.id)
        .sort((a, b) => b.number - a.number)[0];
      const id = `ver_demo_${Date.now()}`;
      const createdAt = new Date().toISOString().slice(0, 10);
      const restoredContent = localizedContentFor(source.id, state.locale, source.content);
      const restoredTitle = localizedTitleFor(prompt.id, state.locale, source.title);
      const version = {
        ...source,
        id,
        number: latest.number + 1,
        title: restoredTitle,
        content: restoredContent,
        source: `Restored from v${source.number} · simulated`,
        createdAt,
        parentVersionId: source.id,
      };
      return {
        ...state,
        versions: [version, ...state.versions],
        prompts: state.prompts.map((item) =>
          item.id === prompt.id ? { ...item, currentVersionId: id, title: restoredTitle } : item,
        ),
        history: [
          {
            id: `his_${Date.now()}`,
            promptId: prompt.id,
            versionId: id,
            source: version.source,
            createdAt,
          },
          ...state.history,
        ],
        draft: {
          promptId: prompt.id,
          title: restoredTitle,
          content: restoredContent,
          taskType: prompt.taskType,
          parentVersionId: id,
          descriptor: prompt.descriptor,
        },
        notice: `Restored as a new version from v${source.number} · Mock / Simulated`,
      };
    }
    case "TOGGLE_FAVORITE":
      return {
        ...state,
        favorites: state.favorites.includes(action.promptId)
          ? state.favorites.filter((id) => id !== action.promptId)
          : [...state.favorites, action.promptId],
        notice: "Favorite updated in this demo session.",
      };
    case "SAVE_TO_LIBRARY":
      return {
        ...state,
        libraryPromptIds: state.libraryPromptIds.includes(action.promptId)
          ? state.libraryPromptIds
          : [action.promptId, ...state.libraryPromptIds],
        notice: "Saved to Library · Mock / Simulated",
      };
    case "REMOVE_FROM_LIBRARY":
      return {
        ...state,
        libraryPromptIds: state.libraryPromptIds.filter((id) => id !== action.promptId),
        notice: "Removed from Library · Prompt history is preserved",
      };
    case "EVALUATE": {
      if (
        !state.prompts.some((p) => p.id === action.promptId) ||
        !state.versions.some((v) => v.id === action.versionId && v.promptId === action.promptId)
      )
        return { ...state, notice: "Evaluation failed; the Prompt version reference is invalid." };
      const report = makeReport(state, action.promptId, action.versionId);
      return {
        ...state,
        reports: [report, ...state.reports],
        notice: "Evaluation preview ready · Mock / Simulated",
      };
    }
    case "CALIBRATE": {
      const prompt = state.prompts.find((p) => p.id === action.promptId);
      const version = state.versions.find(
        (v) => v.id === action.versionId && v.promptId === action.promptId,
      );
      if (
        !prompt ||
        !version ||
        (state.draft.parentVersionId === version.id && state.draft.content !== version.content)
      )
        return {
          ...state,
          notice: "Calibration failed; save the source version and check its evidence.",
        };
      try {
        const report = createCalibrationReport(prompt, version, action.assessments);
        return {
          ...state,
          reports: [report, ...state.reports],
          notice: "Local calibration saved; no AI was called. Grade remains pending.",
        };
      } catch {
        return {
          ...state,
          notice: "Calibration failed; save the source version and check its evidence.",
        };
      }
    }
    case "OPTIMIZE": {
      const prompt = state.prompts.find((item) => item.id === action.promptId);
      if (!prompt) return { ...state, notice: "Prompt not found; draft is preserved." };
      return {
        ...state,
        draft: {
          ...state.draft,
          promptId: action.promptId,
          title: state.draft.promptId === prompt.id ? state.draft.title : prompt.title,
          taskType: prompt.taskType,
          descriptor:
            state.draft.promptId === prompt.id
              ? (state.draft.descriptor ?? prompt.descriptor)
              : prompt.descriptor,
          content: action.content,
          parentVersionId: prompt.currentVersionId,
        },
        notice: "Optimization preview ready; original version is unchanged.",
      };
    }
    case "PLAYGROUND":
      return {
        ...state,
        playgroundRuns: [
          {
            id: `pls_demo_${Date.now()}`,
            versionId: action.versionId,
            outputs: [
              {
                name: "Demo Model A",
                text: "A structured response preview prepared from a local fixture.",
              },
              {
                name: "Demo Model B",
                text: "An alternate simulated response for layout comparison.",
              },
            ],
          },
          ...state.playgroundRuns,
        ],
        notice: "Comparison prepared · Mock / Simulated; no model was called.",
      };
    case "SET_PROFILE":
      return {
        ...state,
        profileName: action.name,
        notice: "Profile updated in this demo session.",
      };
    case "HYDRATE": {
      return restoreState(state, action.saved) ?? { ...state, notice: restoreFailure };
    }
    case "NOTICE":
      return { ...state, notice: action.message };
    case "RESET":
      return createInitialState(state.locale);
    default:
      return state;
  }
}

export function AppStore({ children, locale }: { children: ReactNode; locale: "en" | "zh-CN" }) {
  const protectedPage = isWorkspacePath(usePathname());
  const scope = `${locale}:${protectedPage ? "private" : "public"}`;
  const [state, localDispatch] = useReducer(reducer, locale, createInitialState);
  const [readyScope, setReadyScope] = useState("");
  const [accountId, setAccountId] = useState<string | null>(null);
  const ready = readyScope === scope;
  const accountStorageKey = useRef(storageKey);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === "pm-account-changed") window.location.reload();
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const dispatch = useCallback<AppDispatch>(
    async (action) => {
      if (action.type === "RESET" && accountStorageKey.current !== storageKey) {
        localDispatch({
          type: "NOTICE",
          message: "Demo reset is unavailable for signed-in accounts; your data is unchanged.",
        });
        return "unavailable";
      }
      const current = stateRef.current;
      const next = reducer(current, action);
      if (!isRemoteDemoSyncEnabled()) {
        localDispatch(action);
        return "session";
      }

      let creationKey: string | undefined;
      let request:
        { path: string; method: "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown } | undefined;
      let targetPromptId: string | undefined;

      switch (action.type) {
        case "GENERATE":
        case "CREATE_MANUAL_PROMPT": {
          const proposed = {
            title: action.title,
            taskType: action.taskType,
            content: action.content,
            manualDraft: action.type === "CREATE_MANUAL_PROMPT",
            adoptedUseEventIds: current.draft.adoptedUseEventIds,
            ...(action.descriptor ? { descriptor: action.descriptor } : {}),
          };
          const pending = current.draft.creationRequest;
          const reserved = pending ?? { key: crypto.randomUUID(), ...proposed };
          if (
            pending &&
            JSON.stringify({ ...pending, key: undefined }) !==
              JSON.stringify({ ...proposed, key: undefined })
          ) {
            localDispatch({
              type: "NOTICE",
              message:
                "A creation result is unresolved. Reconcile the original request before changing it.",
            });
            return "unavailable";
          }
          creationKey = reserved.key;
          try {
            if (accountStorageKey.current) {
              const cached = JSON.parse(sessionStorage.getItem(accountStorageKey.current) ?? "{}");
              sessionStorage.setItem(
                accountStorageKey.current,
                JSON.stringify({
                  ...cached,
                  draft: { ...current.draft, creationRequest: reserved },
                }),
              );
            }
          } catch {
            localDispatch({
              type: "NOTICE",
              message: "Cannot retain the request receipt. Enable session storage before saving.",
            });
            return "unavailable";
          }
          localDispatch({ type: "SET_DRAFT", patch: { creationRequest: reserved } });
          stateRef.current = { ...current, draft: { ...current.draft, creationRequest: reserved } };
          request = {
            path: "/api/prompts",
            method: "POST",
            body: {
              title: action.title,
              taskType: action.taskType,
              content: action.content,
              adoptedUseEventIds: reserved.adoptedUseEventIds,
              ...(reserved.descriptor ? { descriptor: reserved.descriptor } : {}),
              ...(action.type === "CREATE_MANUAL_PROMPT" ? { manualDraft: true } : {}),
            },
          };
          break;
        }
        case "SAVE_VERSION": {
          targetPromptId = action.promptId ?? current.draft.promptId ?? undefined;
          const prompt = current.prompts.find((item) => item.id === targetPromptId);
          if (targetPromptId && prompt) {
            request = {
              path: `/api/prompts/${encodeURIComponent(targetPromptId)}/versions`,
              method: "POST",
              body: {
                title:
                  action.title ??
                  (current.draft.promptId === targetPromptId ? current.draft.title : prompt.title),
                content: action.content ?? current.draft.content,
                baseVersionId: action.baseVersionId ?? prompt.currentVersionId,
                parentVersionId:
                  action.parentVersionId ??
                  (current.draft.promptId === targetPromptId
                    ? current.draft.parentVersionId
                    : undefined) ??
                  prompt.currentVersionId,
                source: action.source,
                adoptedUseEventIds:
                  current.draft.promptId === targetPromptId &&
                  (!action.parentVersionId ||
                    action.parentVersionId === current.draft.parentVersionId)
                    ? current.draft.adoptedUseEventIds
                    : undefined,
                optimizationId: action.optimizationId,
                ...(action.descriptor === undefined ? {} : { descriptor: action.descriptor }),
              },
            };
          }
          break;
        }
        case "RESTORE_VERSION": {
          targetPromptId = action.promptId;
          const prompt = current.prompts.find((item) => item.id === action.promptId);
          const source = current.versions.find(
            (item) => item.id === action.versionId && item.promptId === action.promptId,
          );
          if (prompt && source) {
            request = {
              path: `/api/prompts/${encodeURIComponent(action.promptId)}/versions`,
              method: "POST",
              body: {
                title: next.draft.title,
                content: next.draft.content,
                baseVersionId: prompt.currentVersionId,
                parentVersionId: source.id,
                source: `RESTORED_FROM_V${source.number}_MOCK_SIMULATED`,
              },
            };
          }
          break;
        }
        case "EVALUATE": {
          const report = next.reports[0];
          request = {
            path: `/api/prompts/${encodeURIComponent(action.promptId)}/evaluations`,
            method: "POST",
            body: {
              versionId: action.versionId,
              rubricVersion: report.rubricVersion,
              layer1: report.layer1,
              layer2: report.layer2,
            },
          };
          targetPromptId = action.promptId;
          break;
        }
        case "CALIBRATE": {
          const report = next.reports[0];
          request = {
            path: `/api/prompts/${encodeURIComponent(action.promptId)}/evaluations`,
            method: "POST",
            body: {
              versionId: action.versionId,
              rubricVersion: report.rubricVersion,
              layer1: report.layer1,
              layer2: report.layer2,
              layer3: report.layer3,
              source: report.source,
              calibration: report.calibration,
            },
          };
          targetPromptId = action.promptId;
          break;
        }
        case "OPTIMIZE": {
          targetPromptId = action.promptId;
          const prompt = current.prompts.find((item) => item.id === action.promptId);
          if (prompt) {
            request = {
              path: `/api/prompts/${encodeURIComponent(action.promptId)}/optimizations`,
              method: "POST",
              body: { sourceVersionId: prompt.currentVersionId, proposedContent: action.content },
            };
          }
          break;
        }
        case "TOGGLE_FAVORITE":
          request = {
            path: `/api/favorites/${encodeURIComponent(action.promptId)}`,
            method: current.favorites.includes(action.promptId) ? "DELETE" : "PUT",
          };
          break;
        case "SAVE_TO_LIBRARY":
        case "REMOVE_FROM_LIBRARY":
          request = {
            path: `/api/library/${encodeURIComponent(action.promptId)}`,
            method: action.type === "SAVE_TO_LIBRARY" ? "PUT" : "DELETE",
          };
          break;
        case "PLAYGROUND": {
          const version = current.versions.find((item) => item.id === action.versionId);
          const run = next.playgroundRuns[0];
          if (version && run) {
            targetPromptId = version.promptId;
            request = {
              path: "/api/playground/sessions",
              method: "POST",
              body: { promptId: version.promptId, versionId: version.id, outputs: run.outputs },
            };
          }
          break;
        }
        case "SET_PROFILE":
          request = {
            path: "/api/account/profile",
            method: "PATCH",
            body: { displayName: action.name },
          };
          break;
        default:
          break;
      }

      if (!request) {
        localDispatch(action);
        if (action.type === "CALIBRATE") {
          localDispatch({
            type: "NOTICE",
            message: "Calibration remains in this browser session; database sync is not supported.",
          });
        }
        return "session";
      }

      return (async () => {
        const result = await mutateRemoteDemo(
          request.path,
          request.method,
          request.body,
          creationKey,
        );
        if (result.kind === "disabled") {
          localDispatch(action);
          localDispatch({
            type: "NOTICE",
            message:
              "Database API is unavailable; this change is only in the current demo session.",
          });
          return "session";
        }
        if (result.kind === "unavailable") {
          if (
            creationKey &&
            [
              "INVALID_PROMPT_INPUT",
              "INVALID_IDEMPOTENCY_KEY",
              "INVALID_INPUT",
              "AUTH_REQUIRED",
              "FORBIDDEN",
              "ORIGIN_REJECTED",
              "INVALID_SKILL_ADOPTION",
              "SKILL_NOT_FOUND",
              "SKILL_NOT_AVAILABLE",
              "SKILL_CONTEXT_TOO_LARGE",
              "TOO_MANY_SKILLS",
            ].includes(result.code)
          ) {
            localDispatch({ type: "SET_DRAFT", patch: { creationRequest: undefined } });
          }
          const detail =
            result.code === "VERSION_CONFLICT"
              ? "Prompt version changed; reload and retry."
              : "Database sync failed; no local success was shown.";
          localDispatch({ type: "NOTICE", message: detail });
          return "unavailable";
        }

        if (creationKey && result.data && typeof result.data === "object") {
          const created = result.data as { promptId: string; versionId: string; createdAt: string };
          if (typeof created.promptId !== "string" || typeof created.versionId !== "string") {
            localDispatch({
              type: "NOTICE",
              message: "The save response is incomplete. Reconcile the same request.",
            });
            return "unavailable";
          }
          const body = request.body as {
            title: string;
            content: string;
            taskType: AppState["draft"]["taskType"];
            manualDraft?: boolean;
            descriptor?: import("./prompt-description").PromptDescriptor;
          };
          const version = {
            id: created.versionId,
            promptId: created.promptId,
            number: 1,
            title: body.title,
            content: body.content,
            createdBy: "current-user",
            source: body.manualDraft ? "MANUAL_DRAFT" : "MOCK_SIMULATED",
            createdAt: created.createdAt,
          };
          localDispatch({
            type: "HYDRATE",
            saved: {
              prompts: [
                {
                  id: created.promptId,
                  title: body.title,
                  taskType: body.taskType,
                  ...(body.descriptor === undefined ? {} : { descriptor: body.descriptor }),
                  currentVersionId: created.versionId,
                  kind: "PERSONAL_PROMPT",
                  description: "",
                  favorite: false,
                },
                ...current.prompts.filter((p) => p.id !== created.promptId),
              ],
              versions: [version, ...current.versions.filter((v) => v.id !== created.versionId)],
              draft: {
                promptId: created.promptId,
                parentVersionId: created.versionId,
                title: body.title,
                content: body.content,
                taskType: body.taskType,
                descriptor: body.descriptor,
                savedCreation: { promptId: created.promptId, versionId: created.versionId },
              },
            },
          });
        }
        const snapshotResult = await fetchRemoteSnapshot();
        if (snapshotResult.kind !== "ready") {
          localDispatch({
            type: "NOTICE",
            message:
              "Change was sent to the database, but refresh failed; reload to reconcile the view.",
          });
          return "database-refresh-pending";
        }

        const snapshot = snapshotResult.snapshot;
        let draft = next.draft;
        let hydratedPromptId =
          action.type === "GENERATE" ||
          action.type === "CREATE_MANUAL_PROMPT" ||
          action.type === "SAVE_VERSION" ||
          action.type === "RESTORE_VERSION"
            ? targetPromptId
            : undefined;
        if (
          (action.type === "GENERATE" || action.type === "CREATE_MANUAL_PROMPT") &&
          result.data &&
          typeof result.data === "object"
        ) {
          const createdId = (result.data as { promptId?: unknown }).promptId;
          if (typeof createdId === "string") hydratedPromptId = createdId;
        }
        if (
          action.type === "SAVE_VERSION" &&
          action.optimizationId &&
          hasUnsavedDraft(current, current.locale)
        ) {
          hydratedPromptId = undefined;
          draft = current.draft;
        }
        if (hydratedPromptId) {
          const prompt = snapshot.prompts.find((item) => item.id === hydratedPromptId);
          const version = snapshot.versions.find(
            (item) => item.id === prompt?.currentVersionId && item.promptId === hydratedPromptId,
          );
          if (prompt && version) {
            draft = {
              promptId: prompt.id,
              title: prompt.title,
              taskType: prompt.taskType,
              content: version.content,
              descriptor: prompt.descriptor,
              parentVersionId: version.id,
              ...(creationKey
                ? { savedCreation: { promptId: prompt.id, versionId: version.id } }
                : {}),
            };
          }
        }
        localDispatch({
          type: "HYDRATE",
          saved: {
            prompts: snapshot.prompts,
            versions: snapshot.versions,
            reports: snapshot.reports,
            history: snapshot.history,
            libraryPromptIds: snapshot.libraryPromptIds,
            favorites: snapshot.favorites,
            playgroundRuns: snapshot.playgroundRuns,
            liveAdvice: snapshot.liveAdvice,
            profileName: snapshot.profileName,
            draft,
            suggestions: next.suggestions,
          },
        });
        localDispatch({ type: "NOTICE", message: next.notice });
        return "database";
      })().catch(() => {
        localDispatch({
          type: "NOTICE",
          message: "Database sync failed; no local success was shown.",
        });
        return "unavailable";
      });
    },
    [localDispatch],
  );
  useEffect(() => {
    const controller = new AbortController();
    const hydrate = async () => {
      if (!protectedPage) {
        setAccountId(null);
        accountStorageKey.current = "";
        localDispatch({ type: "HYDRATE", saved: emptyWorkspace() });
        setReadyScope(scope);
        return;
      }
      try {
        const response = await fetch("/api/auth/session", {
          cache: "no-store",
          signal: controller.signal,
        });
        const session = response.ok ? await response.json() : null;
        if (controller.signal.aborted) return;
        if (response.status === 401 || (response.ok && !session?.user)) {
          accountStorageKey.current = "";
          localDispatch({ type: "HYDRATE", saved: emptyWorkspace() });
          if (!/\/(login|register)$/.test(window.location.pathname)) {
            window.location.replace(
              loginDestination(
                window.location.pathname + window.location.search,
                locale,
                "expired",
              ),
            );
            return;
          }
          setReadyScope(scope);
          return;
        }
        if (response.ok) {
          setAccountId(session.user.id);
          accountStorageKey.current = `promptmaster-account-${session.user.id}`;
        } else accountStorageKey.current = "";
      } catch {
        if (controller.signal.aborted) return;
        accountStorageKey.current = "";
      }
      if (!accountStorageKey.current) {
        window.location.replace(
          loginDestination(
            window.location.pathname + window.location.search,
            locale,
            "unavailable",
          ),
        );
        return;
      }
      // Authenticated or unknown identity must never inherit demo fixtures.
      if (accountStorageKey.current !== storageKey)
        localDispatch({ type: "HYDRATE", saved: emptyWorkspace() });
      try {
        const raw = accountStorageKey.current
          ? sessionStorage.getItem(accountStorageKey.current)
          : null;
        if (raw) {
          const saved = JSON.parse(raw) as Partial<AppState>;
          if (
            !saved ||
            !Array.isArray(saved.versions) ||
            !Array.isArray(saved.reports) ||
            !Array.isArray(saved.history) ||
            !restoreState(createInitialState(locale), saved)
          ) {
            dispatch({ type: "NOTICE", message: restoreFailure });
          } else {
            dispatch({ type: "HYDRATE", saved });
          }
        }
      } catch {
        dispatch({ type: "NOTICE", message: restoreFailure });
      }

      const result = accountStorageKey.current
        ? await fetchRemoteSnapshot(controller.signal)
        : { kind: "unavailable" as const, code: "IDENTITY_UNAVAILABLE" };
      if (controller.signal.aborted) return;
      if (result.kind === "ready") {
        dispatch({
          type: "HYDRATE",
          saved: {
            prompts: result.snapshot.prompts,
            versions: result.snapshot.versions,
            reports: result.snapshot.reports,
            history: result.snapshot.history,
            libraryPromptIds: result.snapshot.libraryPromptIds,
            favorites: result.snapshot.favorites,
            playgroundRuns: result.snapshot.playgroundRuns,
            liveAdvice: result.snapshot.liveAdvice,
            profileName: result.snapshot.profileName,
          },
        });
      } else if (result.kind === "unavailable") {
        dispatch({
          type: "NOTICE",
          message: "Account data is unavailable; only this account's cached draft is shown.",
        });
      }
      // The server and the first browser render both show this loading shell. Only
      // render fixture/session/database-backed content after browser restoration.
      setReadyScope(scope);
    };
    void hydrate();
    return () => controller.abort();
  }, [dispatch, locale, protectedPage, scope]);
  useEffect(() => {
    if (!ready || !accountStorageKey.current) return;
    const persist = () =>
      sessionStorage.setItem(
        accountStorageKey.current,
        JSON.stringify({
          prompts: state.prompts,
          versions: state.versions,
          reports: state.reports,
          history: state.history,
          libraryPromptIds: state.libraryPromptIds,
          draft: state.draft,
          suggestions: state.suggestions,
          playgroundRuns: state.playgroundRuns,
          liveAdvice: state.liveAdvice,
        }),
      );
    try {
      persist();
    } catch {
      dispatch({
        type: "NOTICE",
        message: "Session storage is unavailable; changes remain in memory only.",
      });
    }
  }, [
    ready,
    state.prompts,
    state.versions,
    state.reports,
    state.history,
    state.libraryPromptIds,
    state.draft,
    state.suggestions,
    state.playgroundRuns,
    state.liveAdvice,
    dispatch,
  ]);
  useEffect(() => {
    void dispatch({ type: "SET_LOCALE", locale });
  }, [dispatch, locale]);
  const value = useMemo(
    () => ({
      state,
      dispatch,
      accountId: protectedPage ? accountId : null,
    }),
    [state, dispatch, accountId, protectedPage],
  );
  return (
    <StoreContext.Provider value={value}>
      {ready ? (
        children
      ) : (
        <div className="mock-banner" role="status">
          PromptMaster AI · {locale === "zh-CN" ? "正在加载工作区" : "Loading workspace"}
        </div>
      )}
    </StoreContext.Provider>
  );
}

export function useAppStore() {
  const value = useContext(StoreContext);
  if (!value) throw new Error("useAppStore must be used inside AppStore");
  return value;
}
