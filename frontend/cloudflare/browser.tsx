import { createRoot } from "react-dom/client";
import { Suspense, useEffect, useState, type ReactNode } from "react";
import Link, { usePathname, useSearchParams } from "./browser-navigation";
import { cloudPageRoute } from "./page-route";
import { AppStore } from "../src/lib/store";
import { AppShell } from "../src/components/AppShell";
import { GlobalNotice } from "../src/components/GlobalNotice";
import { Workspace } from "../src/components/Workspace";
import { CommunityPage } from "../src/components/community/CommunityPage";
import { PelicanPage } from "../src/components/pelican/PelicanPage";
import { Whiteboard } from "../src/components/Whiteboard";
import { loginDestination, safeWorkspaceNext } from "../src/lib/auth-navigation";
import type { Locale } from "../src/lib/types";
import "../src/app/globals.css";
import "../src/app/community.css";
import "../src/app/pelican.css";
import "../src/app/studio.css";
import "../src/app/billing.css";

// APIs still authorize every request. This gate preserves admin-page navigation
// and the existing redirect away from login for already signed-in users.
function AccountGate({ locale, admin, children }: { locale: Locale; admin?: boolean; children: ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/auth/session", { cache: "no-store", signal: controller.signal }).then(async response => {
      const session = response.ok ? await response.json() : null;
      if (controller.signal.aborted) return;
      if (admin) {
        if (session?.user?.role === "ADMIN") setReady(true);
        else window.location.replace(session?.user ? `/${locale}/pelican` : loginDestination(window.location.pathname, locale));
      } else if (session?.user) window.location.replace(safeWorkspaceNext(new URLSearchParams(window.location.search).get("next"), locale));
      else setReady(true);
    }).catch(() => { if (!controller.signal.aborted) setReady(!admin); });
    return () => controller.abort();
  }, [locale, admin]);
  return ready ? children : <p role="status">{locale === "zh-CN" ? "正在验证登录状态…" : "Verifying session…"}</p>;
}
function BrowserApp() {
  const path = usePathname(), search = useSearchParams().toString();
  const route = cloudPageRoute(path === "/" ? "/en" : path, search);
  useEffect(() => { if (path === "/") window.history.replaceState(null, "", "/en" + window.location.search); }, [path]);
  if (!route) return <main><h1>404</h1><Link href="/en">OpenHub</Link></main>;
  const { locale } = route;
  let page: ReactNode;
  if (route.kind === "community") page = <CommunityPage key={`${route.view}:${route.id ?? ""}`} view={route.view} id={route.id} />;
  else if (route.kind === "pelican") {
    page = <PelicanPage key={`${locale}:${route.manage}`} locale={locale} manage={route.manage} />;
    if (route.manage) page = <AccountGate locale={locale} admin>{page}</AccountGate>;
  } else if (route.kind === "whiteboard") page = <Whiteboard locale={locale} />;
  else {
    page = <Workspace key={`${route.page}-${route.promptId ?? ""}-${route.sourceVersionId ?? ""}`} page={route.page} promptId={route.promptId} sourceVersionId={route.sourceVersionId} />;
    if (["login", "register"].includes(route.page)) page = <AccountGate locale={locale}>{page}</AccountGate>;
  }
  return <AppStore key={locale} locale={locale}><Suspense fallback={<p>OpenHub</p>}><AppShell locale={locale}>{page}</AppShell></Suspense><GlobalNotice /></AppStore>;
}
createRoot(document.getElementById("root")!).render(<BrowserApp />);
