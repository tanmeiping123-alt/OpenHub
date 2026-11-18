import type { ComponentProps } from "react";
import type { Workspace } from "../src/components/Workspace";
import type { CommunityView } from "../src/components/community/CommunityPage";
import type { Locale } from "../src/lib/types";
type Page = ComponentProps<typeof Workspace>["page"];
type Route = { locale: Locale } & (
  { kind: "workspace"; page: Page; promptId?: string; sourceVersionId?: string } |
  { kind: "community"; view: CommunityView; id?: string } |
  { kind: "pelican"; manage: boolean } | { kind: "whiteboard" }
);
const pages: Record<string, Page> = {
  "": "home", login: "login", register: "register", help: "help", pricing: "pricing",
  app: "dashboard", "app/generate": "generate", "app/editor": "draft-editor", "app/library": "library",
  "app/history": "history", "app/playground": "playground", "app/execution-evaluation": "execution",
  "app/account": "account", "app/checkout": "checkout", "app/settings": "settings", "app/skills": "skills",
};
export function cloudPageRoute(pathname: string, search = ""): Route | null {
  const segments = pathname.replace(/\/$/, "").split("/").slice(1);
  const locale = segments.shift();
  if (locale !== "en" && locale !== "zh-CN") return null;
  const path = segments.join("/");
  if (path === "app/whiteboard") return { kind: "whiteboard", locale };
  if (segments[0] === "pelican") return segments.length === 1 || path === "pelican/manage" ? { kind: "pelican", locale, manage: path === "pelican/manage" } : null;
  if (segments[0] === "open-prompts") {
    if (segments.length === 1) return { kind: "community", locale, view: "explore" };
    if (segments.length === 2) return { kind: "community", locale, view: ({ new: "publish", me: "mine", moderation: "moderation" } as Record<string, CommunityView>)[segments[1]] ?? "detail", id: segments[1] };
    if (segments.length === 3 && segments[1] === "creators") return { kind: "community", locale, view: "creator", id: segments[2] };
    if (segments.length === 3 && segments[2] === "edit") return { kind: "community", locale, view: "edit", id: segments[1] };
    return null;
  }
  const query = new URLSearchParams(search);
  let page = pages[path], promptId: string | undefined;
  if (!page && segments[0] === "app" && segments[1] === "prompts" && segments.length === 4) {
    page = ({ edit: "editor", evaluate: "evaluator", optimize: "optimizer" } as Record<string, Page>)[segments[3]];
    promptId = segments[2];
  }
  if (!page && segments[0] === "app" && segments[1] === "library" && segments.length === 3) page = "detail";
  if (!page) return null;
  if (["execution", "playground"].includes(page)) promptId = query.get("promptId") ?? undefined;
  return { kind: "workspace", locale, page, promptId, sourceVersionId: query.get("versionId") ?? undefined };
}
