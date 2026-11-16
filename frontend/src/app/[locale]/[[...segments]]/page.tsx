import { notFound, redirect } from "next/navigation";
import { Workspace } from "@/components/Workspace";
import { pageSession } from "@/lib/server/page-session";
import { loginDestination, safeWorkspaceNext } from "@/lib/auth-navigation";
import { CommunityPage, type CommunityView } from "@/components/community/CommunityPage";
import { PelicanPage } from "@/components/pelican/PelicanPage";
import { Whiteboard } from "@/components/Whiteboard";

const routes: Record<string, Parameters<typeof Workspace>[0]["page"]> = {
  "": "home",
  login: "login",
  register: "register",
  help: "help",
  pricing: "pricing",
  app: "dashboard",
  "app/generate": "generate",
  "app/editor": "draft-editor",
  "app/library": "library",
  "app/history": "history",
  "app/playground": "playground",
  "app/execution-evaluation": "execution",
  "app/account": "account",
  "app/checkout": "checkout",
  "app/settings": "settings",
  "app/skills": "skills",
};

export default async function LocalizedPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; segments?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, segments = [] } = await params;
  if (locale !== "en" && locale !== "zh-CN") notFound();
  const path = segments.join("/");
  if (segments[0] === "pelican") {
    const manage = segments.length === 2 && segments[1] === "manage";
    if (segments.length !== 1 && !manage) notFound();
    if (manage) {
      const session = await pageSession();
      if (!session.actor)
        redirect(loginDestination(`/${locale}/pelican/manage`, locale, session.reason));
      if (session.actor.role !== "ADMIN") redirect(`/${locale}/pelican`);
    }
    return <PelicanPage key={`${locale}:${manage}`} locale={locale} manage={manage} />;
  }
  if (segments[0] === "open-prompts") {
    let view: CommunityView | undefined;
    let id: string | undefined;
    if (segments.length === 1) view = "explore";
    else if (segments.length === 2) {
      view = (
        { new: "publish", me: "mine", moderation: "moderation" } as Record<string, CommunityView>
      )[segments[1]];
      if (!view) {
        view = "detail";
        id = segments[1];
      }
    } else if (segments.length === 3 && segments[1] === "creators") {
      view = "creator";
      id = segments[2];
    } else if (segments.length === 3 && segments[2] === "edit") {
      view = "edit";
      id = segments[1];
    }
    if (!view) notFound();
    return <CommunityPage key={`${view}:${id ?? ""}`} view={view} id={id} />;
  }
  if (segments[0] === "app" || path === "login" || path === "register") {
    const session = await pageSession();
    if (segments[0] === "app" && !session.actor) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(await searchParams)) {
        for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value])
          query.append(key, item);
      }
      redirect(
        loginDestination(
          `/${locale}/${path}${query.size ? `?${query}` : ""}`,
          locale,
          session.reason,
        ),
      );
    }
    if ((path === "login" || path === "register") && session.actor)
      redirect(safeWorkspaceNext((await searchParams).next, locale));
  }
  if (path === "app/whiteboard") return <Whiteboard locale={locale} />;
  let page = routes[path];
  let promptId: string | undefined;
  if (!page && segments[0] === "app" && segments[1] === "prompts" && segments.length === 4) {
    promptId = segments[2];
    page = ({ edit: "editor", evaluate: "evaluator", optimize: "optimizer" } as const)[
      segments[3] as "edit" | "evaluate" | "optimize"
    ];
  }
  if (!page && segments[0] === "app" && segments[1] === "library" && segments.length === 3)
    page = "detail";
  if (!page) notFound();
  const query = await searchParams;
  const sourceVersionId = typeof query.versionId === "string" ? query.versionId : undefined;
  if (["execution", "playground"].includes(page) && typeof query.promptId === "string")
    promptId = query.promptId;
  return (
    <Workspace
      key={`${page}-${promptId ?? ""}-${sourceVersionId ?? ""}`}
      page={page}
      promptId={promptId}
      sourceVersionId={sourceVersionId}
    />
  );
}
