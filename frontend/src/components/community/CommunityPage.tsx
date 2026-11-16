"use client";
import { useSearchParams } from "next/navigation";
import { CommunityGate, useCommunity } from "./CommunityShell";
import { CommunityExplore } from "./CommunityExplore";
import { CommunityDetail } from "./CommunityDetail";
import { CommunityPublish } from "./CommunityPublish";
import { CommunityModeration } from "./CommunityModeration";
export type CommunityView =
  "explore" | "detail" | "publish" | "edit" | "mine" | "creator" | "moderation";
export function CommunityPage({ view, id }: { view: CommunityView; id?: string }) {
  const { viewer } = useCommunity();
  const search = useSearchParams();
  if (view === "detail")
    return (
      <CommunityDetail
        key={`${id}:${search.get("version") ?? "latest"}:${viewer?.user?.id ?? "visitor"}`}
        id={id!}
      />
    );
  if (view === "explore" || view === "creator")
    return <CommunityExplore key={`${id ?? "all"}:${search.get("q") ?? ""}`} authorId={id} />;
  return (
    <CommunityGate>
      {view === "publish" || view === "edit" ? (
        <CommunityPublish id={id} />
      ) : view === "moderation" ? (
        <CommunityModeration />
      ) : (
        <CommunityExplore personal />
      )}
    </CommunityGate>
  );
}
