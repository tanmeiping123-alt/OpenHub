"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { useAppStore } from "@/lib/store";
import { descriptorForPrompt } from "@/lib/prompt-description";
import {
  buildSearchDocuments,
  searchDocuments,
  searchSnippet,
  type SearchDocument,
} from "@/lib/workspace-search";

export function WorkspaceSearch({ panelHost }: { panelHost: HTMLElement | null }) {
  const { state, dispatch } = useAppStore();
  const pathname = usePathname();
  const zh = state.locale === "zh-CN";
  const t = (en: string, cn: string) => (zh ? cn : en);
  const field = useRef<HTMLFormElement>(null);
  const panel = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const preview = useRef<HTMLElement>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const expanded = openPath === pathname;
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<SearchDocument | null>(null);
  const documents = useMemo(
    () => buildSearchDocuments({ prompts: state.prompts, versions: state.versions }, state.locale),
    [state.prompts, state.versions, state.locale],
  );
  const results = useMemo(() => searchDocuments(documents, query), [documents, query]);
  const open = useCallback(() => {
    setOpenPath(pathname);
    setSelected(null);
    input.current?.focus();
  }, [pathname]);
  const close = () => {
    input.current?.focus({ preventScroll: true });
    setOpenPath(null);
    setSelected(null);
  };
  useEffect(() => {
    if (selected && expanded) preview.current?.focus({ preventScroll: true });
  }, [selected, expanded]);
  useEffect(() => {
    if (!expanded || !panelHost) return;
    const element = panel.current;
    if (element && element.getBoundingClientRect().top < 52) {
      element.scrollIntoView({ block: "start" });
    }
  }, [expanded, panelHost]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "k" &&
        !event.isComposing
      ) {
        event.preventDefault();
        open();
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [open]);
  useEffect(() => {
    if (!expanded) return;
    const dismiss = (event: Event) => {
      const path = event.composedPath();
      if (
        !path.includes(field.current as EventTarget) &&
        !path.includes(panel.current as EventTarget)
      ) {
        setOpenPath(null);
      }
    };
    document.addEventListener("click", dismiss);
    return () => {
      document.removeEventListener("click", dismiss);
    };
  }, [expanded]);

  return (
    <>
      <form
        ref={field}
        role="search"
        className="topbar-search workspace-search-field"
        aria-label={t("Workspace search", "工作区搜索")}
        onSubmit={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.nativeEvent.isComposing) close();
        }}
      >
        <Search size={16} aria-hidden="true" />
        <input
          ref={input}
          id="workspace-search-input"
          type="search"
          aria-label={t("Search prompts and history", "搜索 Prompt 和历史记录")}
          aria-controls={expanded ? "workspace-search-panel" : undefined}
          aria-keyshortcuts="Control+k Meta+k"
          maxLength={120}
          autoComplete="off"
          placeholder={t("Search prompts and history", "搜索 Prompt 和历史记录")}
          value={query}
          onFocus={open}
          onClick={open}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(null);
            setOpenPath(pathname);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "ArrowDown" || event.key === "Enter") {
              event.preventDefault();
              setOpenPath(pathname);
              panel.current?.querySelector<HTMLButtonElement>(".workspace-search-result")?.focus();
            }
          }}
        />
        {query && (
          <button
            type="button"
            className="icon-btn"
            aria-label={t("Clear search", "清除搜索")}
            onClick={() => {
              setQuery("");
              setSelected(null);
              open();
            }}
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
        <kbd>CTRL＋K</kbd>
      </form>
      {expanded &&
        panelHost &&
        createPortal(
          <section
            ref={panel}
            id="workspace-search-panel"
            className={`workspace-search-panel${selected ? " has-preview" : ""}`}
            aria-label={t("Search your workspace", "搜索工作区")}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !event.nativeEvent.isComposing) {
                event.stopPropagation();
                close();
              }
            }}
          >
            <div className="workspace-search-header between">
              <p role="status">
                {query.trim()
                  ? t(`${results.total} matches`, `${results.total} 条匹配`)
                  : t("Recently saved Prompts", "最近保存的 Prompt")}
              </p>
              <button
                className="icon-btn"
                type="button"
                aria-label={t("Close search", "关闭搜索")}
                onClick={close}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="workspace-search-body">
              {!results.items.length && (
                <p className="workspace-search-empty">{t("No matches found", "没有匹配结果")}</p>
              )}
              <ul
                className="workspace-search-results"
                aria-label={t("Search results", "搜索结果")}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || !["ArrowDown", "ArrowUp"].includes(e.key))
                    return;
                  const buttons = Array.from(
                    e.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
                  );
                  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                  if (index < 0) return;
                  e.preventDefault();
                  if (e.key === "ArrowUp" && index === 0) input.current?.focus();
                  else
                    buttons[
                      (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length
                    ]?.focus();
                }}
              >
                {results.items.map((item) => (
                  <li key={item.version.id}>
                    <button
                      type="button"
                      className="workspace-search-result"
                      aria-pressed={selected?.version.id === item.version.id}
                      onClick={() => {
                        setSelected(item);
                      }}
                    >
                      <span className="between">
                        <strong>{item.title}</strong>
                        <span className="badge">
                          {item.current ? "Prompt" : t("History", "历史版本")} · v
                          {item.version.number}
                        </span>
                      </span>
                      <span className="small subtle">{searchSnippet(item.content, query)}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {selected && (
                <section
                  ref={preview}
                  tabIndex={-1}
                  className="workspace-search-preview"
                  aria-label={t("Read-only preview", "只读预览")}
                >
                  <h3>
                    {selected.title} · v{selected.version.number}
                  </h3>
                  <pre
                    className="result-body"
                    tabIndex={0}
                    aria-label={t("Version content", "版本正文")}
                  >
                    {selected.content}
                  </pre>
                  <Link
                    className="btn btn-primary"
                    href={`/${state.locale}/app/prompts/${selected.prompt.id}/edit`}
                    onClick={(event) => {
                      const base = state.versions.find((v) => v.id === state.draft.parentVersionId);
                      const baseline = base
                        ? buildSearchDocuments(
                            { prompts: state.prompts, versions: [base] },
                            state.locale,
                          )[0]
                        : undefined;
                      const dirty = baseline
                        ? state.draft.content !== baseline.content ||
                          state.draft.title !== baseline.title ||
                          state.draft.taskType !== baseline.prompt.taskType ||
                          JSON.stringify(
                            state.draft.descriptor ?? descriptorForPrompt(baseline.prompt),
                          ) !== JSON.stringify(descriptorForPrompt(baseline.prompt))
                        : !!(state.draft.content || state.draft.title);
                      if (
                        dirty &&
                        !window.confirm(
                          t(
                            "Replace your unsaved draft with this version? Cancel to keep your draft.",
                            "用此版本替换当前未保存草稿？取消可保留草稿。",
                          ),
                        )
                      ) {
                        event.preventDefault();
                        return;
                      }
                      void dispatch({
                        type: "SET_DRAFT",
                        patch: {
                          promptId: selected.prompt.id,
                          title: selected.title,
                          taskType: selected.prompt.taskType,
                          descriptor: selected.prompt.descriptor,
                          content: selected.content,
                          parentVersionId: selected.version.id,
                          creationRequest: undefined,
                          savedCreation: undefined,
                          adoptedUseEventIds: undefined,
                        },
                      });
                      close();
                    }}
                  >
                    {t("Continue editing this version", "继续编辑此版本")}
                  </Link>
                </section>
              )}
            </div>
          </section>,
          panelHost,
        )}
    </>
  );
}
