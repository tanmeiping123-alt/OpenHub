import { createHash } from "node:crypto";
import type {
  PublicationInput,
  CommunitySort,
  CommunityReportCategory,
} from "@/lib/community-types";
import { AccountError } from "../account-errors";
import { isPurposeId, normalizeTags, parsePromptDescriptor } from "@/lib/prompt-description";

const categories = [
  "Coding",
  "UI/UX Design",
  "Writing",
  "Data Analysis",
  "Business",
  "Research",
  "AI Agent",
  "General",
];
const languages = ["zh-CN", "en", "other"];
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AccountError("INVALID_INPUT");
  return value as Record<string, unknown>;
}
export function exact(v: Record<string, unknown>, keys: string[]) {
  if (Object.keys(v).some((k) => !keys.includes(k))) throw new AccountError("INVALID_INPUT");
}
export function text(value: unknown, max: number, required = false) {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (required && !value.trim()) ||
    value.includes("\0")
  )
    throw new AccountError("INVALID_INPUT");
  return value.trim();
}
export function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 1000000)
    throw new AccountError("INVALID_INPUT");
  return value;
}
export function identifier(value: unknown, prefix: string) {
  if (typeof value !== "string" || !new RegExp(`^${prefix}_[a-f0-9-]{36}$`).test(value))
    throw new AccountError("INVALID_INPUT");
  return value;
}
export function requestKey(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(value))
    throw new AccountError("IDEMPOTENCY_KEY_REQUIRED");
  return value;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export const fingerprint = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export const contentHash = (content: string) => createHash("sha256").update(content).digest("hex");
export function publication(value: unknown, updating = false): PublicationInput {
  const v = record(value);
  exact(v, [
    "title",
    "summary",
    "content",
    "taskType",
    "language",
    "tags",
    "purposes",
    "variables",
    "modelNotes",
    "exampleInput",
    "exampleOutput",
    "usageNotes",
    "changeNote",
    "authorName",
    "authorBio",
    "consent",
    "sourceVersionId",
    "sourcePublicId",
    "sourcePublicVersion",
    "baseVersion",
  ]);
  if (v.consent !== true) throw new AccountError("CONSENT_REQUIRED");
  if (typeof v.consent !== "boolean") throw new AccountError("INVALID_INPUT");
  if (updating && v.baseVersion === undefined) throw new AccountError("VERSION_REQUIRED");
  if (!categories.includes(String(v.taskType)) || !languages.includes(String(v.language)))
    throw new AccountError("INVALID_INPUT");
  if (!Array.isArray(v.tags) || v.tags.length > 12) throw new AccountError("INVALID_INPUT");
  text(v.content, 200000, true);
  const result: PublicationInput = {
    title: text(v.title, 240, true),
    summary: text(v.summary, 1000, true),
    content: v.content as string,
    taskType: v.taskType as PublicationInput["taskType"],
    language: v.language as PublicationInput["language"],
    tags: validatedTags(v.tags),
    variables: text(v.variables, 4000),
    modelNotes: text(v.modelNotes, 4000),
    exampleInput: text(v.exampleInput, 10000),
    exampleOutput: text(v.exampleOutput, 10000),
    usageNotes: text(v.usageNotes, 10000),
    changeNote: text(v.changeNote, 1000, updating),
    authorName: text(v.authorName, 80, true),
    authorBio: text(v.authorBio, 500),
    consent: v.consent,
  };
  if (v.purposes !== undefined) {
    try {
      result.purposes = parsePromptDescriptor({ purposes: v.purposes, tags: [] }).purposes;
    } catch {
      throw new AccountError("INVALID_INPUT");
    }
  }
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(result.authorName))
    throw new AccountError("PUBLIC_AUTHOR_NAME_EMAIL_REJECTED");
  if (v.baseVersion !== undefined) result.baseVersion = positive(v.baseVersion);
  if (v.sourceVersionId !== undefined)
    result.sourceVersionId = identifier(v.sourceVersionId, "ver");
  if ((v.sourcePublicId === undefined) !== (v.sourcePublicVersion === undefined))
    throw new AccountError("INVALID_INPUT");
  if (v.sourcePublicId !== undefined) {
    result.sourcePublicId = identifier(v.sourcePublicId, "pub");
    result.sourcePublicVersion = positive(v.sourcePublicVersion);
  }
  return result;
}
export function listQuery(params: URLSearchParams) {
  if (
    [...params.keys()].some(
      (k) =>
        !["q", "category", "language", "sort", "page", "author", "tab", "purpose", "tag"].includes(
          k,
        ),
    ) ||
    [...new Set(params.keys())].some((k) => params.getAll(k).length > 1)
  )
    throw new AccountError("INVALID_INPUT");
  const q = params.get("q") ?? "";
  text(q, 200);
  const category = params.get("category") ?? "";
  const language = params.get("language") ?? "";
  const purpose = params.get("purpose") ?? "";
  const rawTag = params.get("tag") ?? "";
  const tag = rawTag ? validatedTags([rawTag])[0] : "";
  const sort = params.get("sort") ?? (q.trim() ? "relevance" : "stars");
  if (
    (category && !categories.includes(category)) ||
    (language && !languages.includes(language)) ||
    (purpose && !isPurposeId(purpose)) ||
    !["stars", "recent", "newest", "relevance"].includes(sort)
  )
    throw new AccountError("INVALID_INPUT");
  const raw = params.get("page") ?? "1";
  if (!/^[1-9][0-9]{0,5}$/.test(raw)) throw new AccountError("INVALID_INPUT");
  const author = params.get("author") ?? "";
  if (author) identifier(author, "creator");
  const tab = params.get("tab") ?? "published";
  if (!["published", "starred"].includes(tab)) throw new AccountError("INVALID_INPUT");
  return {
    q: q.trim(),
    purpose,
    tag,
    category,
    language,
    sort: sort as CommunitySort,
    page: Number(raw),
    author,
    tab,
  };
}
function validatedTags(value: string[]) {
  try {
    return normalizeTags(value);
  } catch {
    throw new AccountError("INVALID_INPUT");
  }
}
export function starInput(value: unknown) {
  const v = record(value);
  exact(v, ["active", "versionNumber"]);
  if (typeof v.active !== "boolean") throw new AccountError("INVALID_INPUT");
  return { active: v.active, versionNumber: positive(v.versionNumber) };
}
export function reportInput(value: unknown) {
  const v = record(value);
  exact(v, ["category", "detail"]);
  if (!["privacy", "rights", "spam", "other"].includes(String(v.category)))
    throw new AccountError("INVALID_INPUT");
  return { category: v.category as CommunityReportCategory, detail: text(v.detail, 2000, true) };
}
export type ModerationInput = {
  action: "remove" | "restore" | "dismiss" | "excludeStar" | "restoreStar";
  publicId?: string;
  reportId?: string;
  starId?: string;
  reason: string;
};
export type ModerationPages = { reportsPage: number; starsPage: number; eventsPage: number };
export function moderationPages(params: URLSearchParams): ModerationPages {
  const page = (name: keyof ModerationPages) => {
    const value = params.get(name) ?? "1";
    if (!/^[1-9][0-9]{0,6}$/.test(value)) throw new AccountError("INVALID_INPUT");
    return positive(Number(value));
  };
  return {
    reportsPage: page("reportsPage"),
    starsPage: page("starsPage"),
    eventsPage: page("eventsPage"),
  };
}
export function moderationInput(value: unknown): ModerationInput {
  const v = record(value);
  exact(v, ["action", "publicId", "reportId", "starId", "reason"]);
  if (!["remove", "restore", "dismiss", "excludeStar", "restoreStar"].includes(String(v.action)))
    throw new AccountError("INVALID_INPUT");
  const result: ModerationInput = {
    action: v.action as ModerationInput["action"],
    reason: text(v.reason, 2000, true),
  };
  if (v.publicId !== undefined) result.publicId = identifier(v.publicId, "pub");
  if (v.reportId !== undefined) result.reportId = identifier(v.reportId, "report");
  if (v.starId !== undefined) result.starId = identifier(v.starId, "star");
  if (
    ["remove", "restore"].includes(result.action)
      ? !result.publicId || !!result.starId || !!result.reportId
      : result.action === "dismiss"
        ? !result.reportId || !!result.publicId || !!result.starId
        : !result.starId || !!result.publicId || !!result.reportId
  )
    throw new AccountError("INVALID_INPUT");
  return result;
}
