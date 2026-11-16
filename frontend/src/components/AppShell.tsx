"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Compass,
  CircleHelp,
  Braces,
  CreditCard,
  Globe2,
  History,
  LayoutDashboard,
  Library,
  ListChecks,
  Play,
  Settings2,
  Sparkles,
  UserRound,
  Menu,
  X,
  Bike,
  PanelLeftClose,
  PanelLeftOpen,
  PenTool,
  Blocks,
} from "lucide-react";
import { useAppStore } from "@/lib/store";
import type { Locale } from "@/lib/types";
import { localizedMode } from "@/lib/fixtures";
import { SignOutButton } from "./SignOutButton";
import { SessionBoundary } from "./SessionBoundary";
import { WorkspaceSearch } from "./WorkspaceSearch";
import { CommunityShell } from "./community/CommunityShell";
import { useSidebarPreference } from "@/lib/sidebar-preference";

type Entry = { label: string; path: string; icon: typeof Compass };
const tx = (locale: Locale, en: string, zh: string) => (locale === "zh-CN" ? zh : en);

export function AppShell({ children, locale }: { children: React.ReactNode; locale: string }) {
  const { state, dispatch } = useAppStore();
  const pathname = usePathname();
  const router = useRouter();
  const { collapsed, toggle } = useSidebarPreference();
  const [searchHost, setSearchHost] = useState<HTMLDivElement | null>(null);
  const mobileMenu = useRef<HTMLDialogElement>(null);
  const mobileMenuTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const menu = mobileMenu.current;
    const restore = () => mobileMenuTrigger.current?.focus();
    menu?.addEventListener("close", restore);
    return () => menu?.removeEventListener("close", restore);
  }, [pathname]);
  useEffect(() => {
    mobileMenu.current?.close();
  }, [pathname]);
  const isPublic = /^\/(en|zh-CN)(?:\/(login|register|pricing|help))?\/?$/.test(pathname);
  const root = `/${locale}`;
  const links = useMemo(
    () => ({
      dashboard: {
        label: tx(state.locale, "Dashboard", "工作台"),
        path: `${root}/app`,
        icon: LayoutDashboard,
      },
      community: {
        label: "Open Prompt",
        path: `${root}/open-prompts`,
        icon: Compass,
      },
      generate: {
        label: tx(state.locale, "Generate", "生成 Prompt"),
        path: `${root}/app/generate`,
        icon: Sparkles,
      },
      whiteboard: {
        label: tx(state.locale, "Excalidraw whiteboard", "Excalidraw 白板"),
        path: `${root}/app/whiteboard`,
        icon: PenTool,
      },
      library: {
        label: tx(state.locale, "My Prompts", "我的 Prompt"),
        path: `${root}/app/library`,
        icon: Library,
      },
      skills: {
        label: tx(state.locale, "Skills", "Skills 管理"),
        path: `${root}/app/skills`,
        icon: Blocks,
      },
      history: {
        label: tx(state.locale, "History", "版本历史"),
        path: `${root}/app/history`,
        icon: History,
      },
      pelican: {
        label: tx(state.locale, "Pelican Observatory", "鹈鹕测智"),
        path: `${root}/pelican`,
        icon: Bike,
      },
      playground: {
        label: tx(state.locale, "Playground", "模型试跑"),
        path: `${root}/app/playground`,
        icon: Play,
      },
      evaluation: {
        label: tx(state.locale, "Evaluation report", "评估报告"),
        path: `${root}/app/execution-evaluation`,
        icon: ListChecks,
      },
      account: [
        {
          label: tx(state.locale, "Profile", "账户资料"),
          path: `${root}/app/account`,
          icon: UserRound,
        },
        {
          label: tx(state.locale, "Settings", "设置"),
          path: `${root}/app/settings`,
          icon: Settings2,
        },
        { label: tx(state.locale, "Plans", "方案"), path: `${root}/pricing`, icon: CreditCard },
        { label: tx(state.locale, "Help", "帮助"), path: `${root}/help`, icon: CircleHelp },
      ] as Entry[],
    }),
    [root, state.locale],
  );
  const switchLocale = () => {
    const next = locale === "en" ? "zh-CN" : "en";
    dispatch({ type: "SET_LOCALE", locale: next });
    document.documentElement.lang = next;
    const query = new URLSearchParams(window.location.search);
    if (query.has("next"))
      query.set("next", (query.get("next") ?? "").replace(/^\/(en|zh-CN)\//, `/${next}/`));
    router.push(pathname.replace(/^\/(en|zh-CN)/, `/${next}`) + (query.size ? `?${query}` : ""));
  };
  const navLink = (entry: Entry, mobile = false) => {
    const Icon = entry.icon;
    const active =
      pathname === entry.path ||
      (entry.path.endsWith("/app") && pathname === entry.path) ||
      (entry.path.endsWith("/library") && pathname.includes("/library/"));
    return (
      <Link
        key={entry.path}
        href={entry.path}
        className={`${mobile ? "" : "nav-link"} ${active ? "active" : ""}`}
        aria-current={active ? "page" : undefined}
        aria-label={entry.label}
        title={!mobile && collapsed ? entry.label : undefined}
      >
        <Icon size={18} aria-hidden="true" />
        <span>{entry.label}</span>
      </Link>
    );
  };
  const navigationGroups: Entry[][] = [
    [links.dashboard],
    [links.generate, links.whiteboard],
    [links.library, links.skills, links.history],
    [links.playground, links.evaluation, links.pelican],
    [links.community],
  ];
  const all = [...navigationGroups.flat(), ...links.account];
  const isWhiteboard = pathname === `${root}/app/whiteboard`;
  if (/^\/(en|zh-CN)\/pelican(?:\/|$)/.test(pathname)) return <>{children}</>;
  if (/^\/(en|zh-CN)\/open-prompts(?:\/|$)/.test(pathname))
    return <CommunityShell locale={locale as Locale}>{children}</CommunityShell>;
  if (isPublic)
    return (
      <div className="public-layout">
        <header className="public-header">
          <Link href={root} className="brand" aria-label="PromptMaster AI">
            <span className="brand-mark">
              <Braces size={20} aria-hidden="true" />
            </span>
            PromptMaster AI
          </Link>
          <div className="row">
            <Link className="btn btn-sm" href={`${root}/pelican`}>
              {tx(state.locale, "Pelican Observatory", "鹈鹕测智")}
            </Link>
            <Link className="btn btn-sm" href={`${root}/open-prompts`}>
              Open Prompt
            </Link>
            <Link className="btn btn-sm" href={`${root}/help`}>
              {tx(state.locale, "Help", "帮助")}
            </Link>
            <button
              className="btn btn-sm"
              onClick={switchLocale}
              aria-label={tx(state.locale, "Switch language", "切换语言")}
            >
              <Globe2 size={15} />
              {locale === "en" ? "中文" : "EN"}
            </button>
            <Link className="btn btn-sm" href={`${root}/login`}>
              {tx(state.locale, "Log in", "登录")}
            </Link>
            <Link className="btn btn-primary btn-sm" href={`${root}/register`}>
              {tx(state.locale, "Sign up", "注册")}
            </Link>
          </div>
        </header>
        {children}
      </div>
    );
  return (
    <SessionBoundary locale={state.locale}>
      <div className={`app-frame${collapsed ? " sidebar-collapsed" : ""}`}>
        <a className="workspace-skip" href="#workspace-main">
          {tx(state.locale, "Skip to content", "跳到主要内容")}
        </a>
        <header className="topbar">
          <Link href={root} className="brand" aria-label="PromptMaster AI">
            <span className="brand-mark">
              <Braces size={20} aria-hidden="true" />
            </span>
            <span>PromptMaster AI</span>
          </Link>
          <WorkspaceSearch key={state.locale} panelHost={searchHost} />
          <div className="topbar-actions">
            <button
              className="btn btn-sm mode-switch"
              aria-label={tx(
                state.locale,
                `Professional mode · Current: ${localizedMode(state.mode, state.locale)}`,
                `专家模式 · 当前：${localizedMode(state.mode, state.locale)}`,
              )}
              aria-pressed={state.mode === "professional"}
              onClick={() =>
                dispatch({
                  type: "SET_MODE",
                  mode: state.mode === "simple" ? "professional" : "simple",
                })
              }
            >
              <span>{localizedMode(state.mode, state.locale)}</span>
              <span className="subtle">⌄</span>
            </button>
            <button
              className="btn btn-sm"
              onClick={switchLocale}
              aria-label={tx(state.locale, "Switch language", "切换语言")}
            >
              <Globe2 size={15} />
              {locale === "en" ? "中文" : "EN"}
            </button>
            <Link
              className="icon-btn"
              href={`${root}/app/account`}
              aria-label={tx(state.locale, "Account profile", "账户资料")}
            >
              <UserRound size={17} />
            </Link>
            <SignOutButton locale={state.locale} />
          </div>
        </header>
        <div className="shell">
          <aside
            id="workspace-sidebar"
            className="sidebar"
            aria-label={tx(state.locale, "Workspace navigation", "工作区导航")}
          >
            <div className="sidebar-header">
              <button
                className="icon-btn sidebar-toggle"
                onClick={toggle}
                aria-label={tx(
                  state.locale,
                  collapsed ? "Expand navigation" : "Collapse navigation",
                  collapsed ? "展开导航" : "收起导航",
                )}
                title={tx(
                  state.locale,
                  collapsed ? "Expand navigation" : "Collapse navigation",
                  collapsed ? "展开导航" : "收起导航",
                )}
                aria-expanded={!collapsed}
                aria-controls="workspace-sidebar"
              >
                {collapsed ? (
                  <PanelLeftOpen size={19} aria-hidden="true" />
                ) : (
                  <PanelLeftClose size={19} aria-hidden="true" />
                )}
                {!collapsed && <span>{tx(state.locale, "Collapse", "收起")}</span>}
              </button>
            </div>
            <nav
              aria-label={tx(state.locale, "Workspace tools", "工作区工具")}
              className="sidebar-tools"
            >
              {navigationGroups.map((group) => (
                <div className="sidebar-group" key={group[0].path}>
                  {group.map((entry) => navLink(entry))}
                </div>
              ))}
            </nav>
            {collapsed ? (
              <nav
                className="sidebar-account-icons"
                aria-label={tx(state.locale, "Account & settings", "账户与设置")}
              >
                {links.account.map((entry) => navLink(entry))}
              </nav>
            ) : (
              <details className="sidebar-account">
                <summary>{tx(state.locale, "Account & settings", "账户与设置")}</summary>
                {links.account.map((entry) => navLink(entry))}
              </details>
            )}
          </aside>
          <main
            className={`main-area${isWhiteboard ? " main-area-whiteboard" : ""}`}
            id="workspace-main"
            tabIndex={-1}
          >
            <div ref={setSearchHost} className="workspace-search-slot" />
            <div className="main-inner">{children}</div>
          </main>
        </div>
        <nav className="mobile-nav" aria-label={tx(state.locale, "Primary navigation", "主导航")}>
          {[links.dashboard, links.library, links.generate, links.community].map((entry) =>
            navLink(entry, true),
          )}
          <button
            ref={mobileMenuTrigger}
            onClick={() => mobileMenu.current?.showModal()}
            aria-label={tx(state.locale, "More navigation", "更多导航")}
          >
            <Menu size={19} aria-hidden="true" />
            <span>{tx(state.locale, "More", "更多")}</span>
          </button>
        </nav>
        <dialog
          ref={mobileMenu}
          className="workspace-menu"
          aria-labelledby="workspace-menu-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) mobileMenu.current?.close();
          }}
        >
          <div className="workspace-menu-content">
            <div className="between">
              <h2 id="workspace-menu-title">{tx(state.locale, "All navigation", "全部导航")}</h2>
              <button
                className="icon-btn"
                aria-label={tx(state.locale, "Close navigation", "关闭导航")}
                onClick={() => mobileMenu.current?.close()}
              >
                <X size={20} aria-hidden="true" />
              </button>
            </div>
            <nav
              className="workspace-menu-links"
              aria-label={tx(state.locale, "All tools", "所有工具")}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("a")) mobileMenu.current?.close();
              }}
            >
              {all.map((entry) => navLink(entry))}
            </nav>
            <button
              className="btn"
              aria-pressed={state.mode === "professional"}
              onClick={() =>
                dispatch({
                  type: "SET_MODE",
                  mode: state.mode === "simple" ? "professional" : "simple",
                })
              }
            >
              {localizedMode(state.mode, state.locale)}
            </button>
          </div>
        </dialog>
      </div>
    </SessionBoundary>
  );
}
