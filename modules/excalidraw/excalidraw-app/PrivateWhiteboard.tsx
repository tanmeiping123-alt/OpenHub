import { useEffect, useRef, useState } from "react";
import { Excalidraw, MainMenu, WelcomeScreen } from "@excalidraw/excalidraw";
import { EditorLocalStorage } from "@excalidraw/excalidraw/data/EditorLocalStorage";
import { clearAppStateForLocalStorage } from "@excalidraw/excalidraw/appState";
import { serializeAsJSON } from "@excalidraw/excalidraw/data/json";

import type {
  AppState,
  BinaryFiles,
  ExcalidrawInitialDataState,
  LibraryItems,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import "./private-whiteboard.scss";

type Scene = {
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
};
type Board = {
  ownerId: string;
  revision: number;
  scene: Scene;
  libraryItems: LibraryItems;
};
type SaveStatus = "saved" | "saving" | "error" | "conflict";

function persistentState(state: AppState): Partial<AppState> {
  const clean = clearAppStateForLocalStorage(state);
  return {
    ...clean,
    openMenu: null,
    openSidebar: null,
    selectedElementIds: {},
    selectedGroupIds: {},
    previousSelectedElementIds: {},
    editingGroupId: null,
    cursorButton: "up",
    scrolledOutside: false,
  };
}

class BoardError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export default function PrivateWhiteboard() {
  const host = useRef<HTMLDivElement>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [locale, setLocale] = useState("zh-CN");
  const [embedded, setEmbedded] = useState(false);
  const [bootError, setBootError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const win = host.current?.ownerDocument.defaultView;
    if (!win) {
      return;
    }
    const params = new URLSearchParams(win.location.search);
    setLocale(params.get("lng") === "en" ? "en" : "zh-CN");
    setEmbedded(params.get("embed") === "true");
    const abort = new AbortController();
    setBootError("");
    void fetch("/api/whiteboard", {
      credentials: "same-origin",
      cache: "no-store",
      headers: params.get("owner")
        ? { "x-whiteboard-owner": params.get("owner")! }
        : {},
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]),
    })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) {
          throw new BoardError(data.error);
        }
        if (abort.signal.aborted) {
          return;
        }
        // The public Excalidraw app and its unowned caches never initialize here.
        EditorLocalStorage.setNamespace(`pm-whiteboard:${data.ownerId}:`);
        setBoard(data);
      })
      .catch((e) => {
        if (!abort.signal.aborted) {
          setBootError(e instanceof BoardError ? e.code : "UNAVAILABLE");
        }
      });
    return () => abort.abort();
  }, [attempt]);
  const zh = locale === "zh-CN";
  return (
    <div ref={host} className="pm-whiteboard">
      {board ? (
        <PrivateEditor
          key={board.ownerId}
          initial={board}
          locale={locale}
          embedded={embedded}
          onLock={(reason) => {
            setBoard(null);
            setBootError(reason);
          }}
        />
      ) : (
        <div className="pm-whiteboard-gate" role="status">
          <h1>{zh ? "Excalidraw 白板" : "Excalidraw whiteboard"}</h1>
          <p>
            {!bootError
              ? zh
                ? "正在验证并加载私有白板…"
                : "Loading your private whiteboard…"
              : ["AUTH_REQUIRED", "WHITEBOARD_ACCOUNT_CHANGED"].includes(
                  bootError,
                )
              ? zh
                ? "登录状态已改变，请重新打开白板。"
                : "Your session changed. Reopen your whiteboard."
              : zh
              ? "白板暂时无法加载，请重试。"
              : "The whiteboard could not load. Please retry."}
          </p>
          {bootError && (
            <div className="pm-whiteboard-actions">
              {bootError === "AUTH_REQUIRED" ? (
                <a
                  href={`/${locale}/login?next=${encodeURIComponent(
                    `/${locale}/app/whiteboard`,
                  )}`}
                  target="_top"
                >
                  {zh ? "登录" : "Log in"}
                </a>
              ) : (
                <button
                  onClick={() => {
                    if (bootError === "WHITEBOARD_ACCOUNT_CHANGED") {
                      host.current?.ownerDocument.defaultView?.location.replace(
                        `/${locale}/app/whiteboard`,
                      );
                    } else {
                      setAttempt((n) => n + 1);
                    }
                  }}
                >
                  {zh ? "重新打开" : "Reopen"}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PrivateEditor({
  initial,
  locale,
  embedded,
  onLock,
}: {
  initial: Board;
  locale: string;
  embedded: boolean;
  onLock: (reason: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const ready = useRef(false);
  const locked = useRef(false);
  const revision = useRef(initial.revision);
  const scene = useRef(initial.scene);
  const library = useRef(initial.libraryItems);
  const pending = useRef<string | null>(null);
  const dirty = useRef(false);
  const acknowledged = useRef("");
  const saving = useRef(false);
  const lastFailed = useRef<string | null>(null);
  const conflict = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const save = useRef<(keepalive?: boolean) => Promise<void>>(async () => {});
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [saveError, setSaveError] = useState("");
  const [verified, setVerified] = useState(false);
  const zh = locale === "zh-CN";
  const title = zh ? "Excalidraw 白板" : "Excalidraw whiteboard";

  const lock = (reason: string) => {
    locked.current = true;
    pending.current = null;
    dirty.current = false;
    scene.current = { elements: [], appState: {}, files: {} };
    library.current = [];
    clearTimeout(timer.current);
    onLock(reason);
  };
  const snapshot = () =>
    JSON.stringify({ scene: scene.current, libraryItems: library.current });
  const enqueue = () => {
    if (!ready.current || locked.current) {
      return;
    }
    // Drawing emits changes on every pointer movement. Serialize after the
    // debounce, so image data and large scenes do not block pointer handling.
    dirty.current = true;
    clearTimeout(timer.current);
    if (!conflict.current) {
      timer.current = setTimeout(() => void save.current(), 500);
    }
  };

  save.current = async (keepalive = false) => {
    if (
      saving.current ||
      (!pending.current && !dirty.current) ||
      locked.current ||
      conflict.current
    ) {
      return;
    }
    if (dirty.current) {
      pending.current = snapshot();
      dirty.current = false;
    }
    const payload = pending.current!;
    if (payload === lastFailed.current) {
      return;
    }
    if (payload === acknowledged.current) {
      pending.current = null;
      setStatus("saved");
      return;
    }
    saving.current = true;
    setStatus("saving");
    let saved = false;
    try {
      const body = JSON.stringify({
        ownerId: initial.ownerId,
        revision: revision.current,
        ...JSON.parse(payload),
      });
      const response = await fetch("/api/whiteboard", {
        method: "PUT",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body,
        keepalive: keepalive && new Blob([body]).size < 60000,
        signal: AbortSignal.timeout(20000),
      });
      const result = await response.json();
      if (locked.current) {
        return;
      }
      if (
        response.status === 401 ||
        result.error === "WHITEBOARD_ACCOUNT_CHANGED"
      ) {
        lock(result.error);
        return;
      }
      if (result.error === "WHITEBOARD_VERSION_CONFLICT") {
        // A lost response may have committed this exact snapshot. Recover its
        // acknowledgement, but never replace another tab's different changes.
        const latestResponse = await fetch("/api/whiteboard", {
          cache: "no-store",
          headers: { "x-whiteboard-owner": initial.ownerId },
          signal: AbortSignal.timeout(15000),
        });
        const latest = await latestResponse.json();
        if (
          latestResponse.status === 401 ||
          latest.error === "WHITEBOARD_ACCOUNT_CHANGED"
        ) {
          lock(latest.error);
          return;
        }
        if (
          !latestResponse.ok ||
          JSON.stringify(
            canonical({
              scene: latest.scene,
              libraryItems: latest.libraryItems,
            }),
          ) !== JSON.stringify(canonical(JSON.parse(payload)))
        ) {
          throw new BoardError(result.error);
        }
        result.revision = latest.revision;
      } else if (!response.ok) {
        throw new BoardError(result.error);
      }
      revision.current = result.revision;
      acknowledged.current = payload;
      if (pending.current === payload) {
        pending.current = null;
      }
      setStatus(pending.current || dirty.current ? "saving" : "saved");
      setSaveError("");
      lastFailed.current = null;
      saved = true;
    } catch (e) {
      if (locked.current) {
        return;
      }
      const code = e instanceof BoardError ? e.code : "UNAVAILABLE";
      lastFailed.current = payload;
      conflict.current = code === "WHITEBOARD_VERSION_CONFLICT";
      setStatus(conflict.current ? "conflict" : "error");
      setSaveError(code);
    } finally {
      saving.current = false;
      if (
        (pending.current || dirty.current) &&
        !locked.current &&
        !conflict.current &&
        saved
      ) {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => void save.current(), 250);
      }
    }
  };

  useEffect(() => {
    const doc = host.current?.ownerDocument;
    const win = doc?.defaultView;
    if (!doc || !win) {
      return;
    }
    const abort = new AbortController();
    let checking = false;
    const verify = async () => {
      if (checking || locked.current || doc.visibilityState !== "visible") {
        return;
      }
      checking = true;
      try {
        const r = await fetch("/api/whiteboard", {
          credentials: "same-origin",
          cache: "no-store",
          method: "GET",
          headers: {
            "x-whiteboard-owner": initial.ownerId,
            "x-whiteboard-check": "identity",
          },
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
        });
        if (abort.signal.aborted) {
          return;
        }
        if (r.status === 401 || r.status === 409) {
          lock(
            r.status === 401 ? "AUTH_REQUIRED" : "WHITEBOARD_ACCOUNT_CHANGED",
          );
          return;
        }
        setVerified(r.ok);
      } catch {
        if (!abort.signal.aborted) {
          setVerified(false);
        }
      } finally {
        checking = false;
      }
    };
    const visibility = () => {
      setVerified(false);
      if (doc.visibilityState === "visible") {
        void verify();
      }
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if ((pending.current || dirty.current) && !locked.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const pageHide = () => {
      setVerified(false);
      clearTimeout(timer.current);
      void save.current(true);
    };
    const accountChanged = (event: StorageEvent) => {
      if (event.key === "pm-account-changed") {
        setVerified(false);
        void verify();
      }
    };
    const interval = win.setInterval(() => void verify(), 15000);
    void verify();
    win.addEventListener("focus", verify);
    win.addEventListener("pageshow", visibility);
    win.addEventListener("pagehide", pageHide);
    win.addEventListener("beforeunload", beforeUnload);
    win.addEventListener("storage", accountChanged);
    doc.addEventListener("visibilitychange", visibility);
    return () => {
      abort.abort();
      clearTimeout(timer.current);
      win.clearInterval(interval);
      win.removeEventListener("focus", verify);
      win.removeEventListener("pageshow", visibility);
      win.removeEventListener("pagehide", pageHide);
      win.removeEventListener("beforeunload", beforeUnload);
      win.removeEventListener("storage", accountChanged);
      doc.removeEventListener("visibilitychange", visibility);
      void save.current(true);
    };
    // Identity is fixed for this editor's lifetime; every request rechecks it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.ownerId]);

  const exportPending = () => {
    const doc = host.current?.ownerDocument;
    const win = doc?.defaultView;
    if (!doc || !win) {
      return;
    }
    const data = {
      ...JSON.parse(
        serializeAsJSON(
          scene.current.elements,
          scene.current.appState,
          scene.current.files,
          "local",
        ),
      ),
      libraryItems: library.current,
    };
    const url = win.URL.createObjectURL(
      new Blob([JSON.stringify(data)], { type: "application/json" }),
    );
    const a = doc.createElement("a");
    a.href = url;
    a.download = "private-whiteboard.excalidraw";
    a.click();
    win.setTimeout(() => win.URL.revokeObjectURL(url), 1000);
  };
  const initialData = useRef<ExcalidrawInitialDataState>({
    ...initial.scene,
    libraryItems: initial.libraryItems,
  });
  return (
    <div ref={host} className="pm-private-editor">
      <header className="pm-whiteboard-header">
        <h1 aria-label={title}>
          <span>
            <span className="pm-title-brand">Excalidraw </span>
            {zh ? "白板" : "whiteboard"}
          </span>
          <svg
            viewBox="0 0 24 24"
            width="15"
            height="15"
            role="img"
            aria-label={zh ? "私有白板" : "Private whiteboard"}
          >
            <title>
              {zh
                ? "仅当前账号可访问"
                : "Only your account can access this board"}
            </title>
            <rect x="5" y="10" width="14" height="11" rx="3" />
            <path d="M8 10V7a4 4 0 0 1 8 0v3" />
          </svg>
        </h1>
        <div className="pm-whiteboard-header-actions">
          <span
            className={`pm-save-dot pm-save-dot--${status}`}
            role="status"
            aria-label={
              status === "saved"
                ? zh
                  ? "已保存"
                  : "Saved"
                : status === "saving"
                ? zh
                  ? "正在保存…"
                  : "Saving…"
                : zh
                ? "未保存"
                : "Not saved"
            }
            title={
              status === "saved"
                ? zh
                  ? "已私有保存"
                  : "Saved privately"
                : zh
                ? "正在保存或等待重试"
                : "Saving or waiting to retry"
            }
          />
          <a
            aria-label={
              embedded
                ? zh
                  ? "独立打开"
                  : "Open separately"
                : zh
                ? "返回工作区"
                : "Back to workspace"
            }
            href={
              embedded
                ? `/modules/excalidraw/index.html?lng=${locale}&owner=${encodeURIComponent(
                    initial.ownerId,
                  )}`
                : `/${locale}/app/whiteboard`
            }
            target={embedded ? "_blank" : "_self"}
            rel="noreferrer"
          >
            <span className="pm-open-label">
              {embedded
                ? zh
                  ? "独立打开"
                  : "Open separately"
                : zh
                ? "返回工作区"
                : "Back to workspace"}
            </span>
            <span aria-hidden="true">↗</span>
          </a>
        </div>
      </header>
      <div
        className="pm-whiteboard-editor"
        style={{ visibility: verified ? "visible" : "hidden" }}
      >
        <Excalidraw
          initialData={initialData.current}
          langCode={locale}
          aiEnabled={false}
          UIOptions={{ librarySharing: false }}
          autoFocus={false}
          validateEmbeddable={false}
          onInitialize={(api) => {
            scene.current = {
              elements: api.getSceneElements(),
              appState: persistentState(api.getAppState()),
              files: api.getFiles(),
            };
            acknowledged.current = snapshot();
            ready.current = true;
          }}
          onChange={(elements, appState, files) => {
            if (!ready.current) {
              return;
            }
            // Store serializable editor state, never handles, collaborators or runtime objects.
            scene.current = {
              elements,
              appState: persistentState(appState),
              files,
            };
            enqueue();
          }}
          onLibraryChange={(items) => {
            library.current = items;
            enqueue();
          }}
        >
          <MainMenu>
            <MainMenu.DefaultItems.LoadScene />
            <MainMenu.DefaultItems.SaveToActiveFile />
            <MainMenu.DefaultItems.Export />
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.CommandPalette />
            <MainMenu.DefaultItems.SearchMenu />
            <MainMenu.DefaultItems.Help />
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.Separator />
            <MainMenu.DefaultItems.Preferences />
            <MainMenu.DefaultItems.ToggleTheme allowSystemTheme={false} />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
          </MainMenu>
          <WelcomeScreen>
            <WelcomeScreen.Center>
              <WelcomeScreen.Center.Menu>
                <WelcomeScreen.Center.MenuItemLoadScene />
              </WelcomeScreen.Center.Menu>
            </WelcomeScreen.Center>
          </WelcomeScreen>
        </Excalidraw>
      </div>
      {!verified && (
        <div
          className="pm-whiteboard-gate pm-whiteboard-verification"
          role="status"
        >
          <p>
            {zh ? "正在重新验证白板访问权限…" : "Verifying whiteboard access…"}
          </p>
          <button
            onClick={() =>
              host.current?.ownerDocument.defaultView?.dispatchEvent(
                new Event("focus"),
              )
            }
          >
            {zh ? "重新验证" : "Retry verification"}
          </button>
        </div>
      )}
      {(status === "error" || status === "conflict") && verified && (
        <div className="pm-whiteboard-error" role="alert">
          <span>
            {status === "conflict"
              ? zh
                ? "其他标签页已更新白板。请先导出当前内容，再重新打开。"
                : "Another tab updated this board. Export your changes before reopening."
              : saveError === "REQUEST_TOO_LARGE"
              ? zh
                ? "白板超过保存大小限制，请导出备份并减少图片。"
                : "This board exceeds the save limit. Export a backup and reduce images."
              : zh
              ? "保存失败，当前内容仍保留在此页面。"
              : "Save failed. Your changes remain on this page."}
          </span>
          {status === "error" && (
            <button
              onClick={() => {
                setSaveError("");
                lastFailed.current = null;
                void save.current();
              }}
            >
              {zh ? "重试保存" : "Retry save"}
            </button>
          )}
          <button onClick={exportPending}>
            {zh ? "导出备份" : "Export backup"}
          </button>
          {status === "conflict" && (
            <button
              onClick={() =>
                host.current?.ownerDocument.defaultView?.location.reload()
              }
            >
              {zh ? "重新打开" : "Reopen"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
