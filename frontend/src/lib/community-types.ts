import type { TaskType } from "./types";
import type { PromptDescriptor, PurposeId } from "./prompt-description";

export type CommunitySort = "stars" | "recent" | "newest" | "relevance";
export type CommunityStatus = "PUBLISHED" | "WITHDRAWN" | "REMOVED";
export type CommunityAuthor = { id: string; name: string; bio: string };
export type CommunityOrigin = {
  publicId: string;
  versionNumber: number;
  title: string;
  available: boolean;
};
export type CommunityCard = {
  purposes?: PurposeId[];
  id: string;
  title: string;
  summary: string;
  taskType: TaskType;
  language: "zh-CN" | "en" | "other";
  tags: string[];
  author: CommunityAuthor;
  stars: number;
  recentStars: number;
  versionNumber: number;
  firstPublishedAt: string;
  updatedAt: string;
  status: CommunityStatus;
};
export type CommunityVersion = {
  number: number;
  content: string;
  variables: string;
  modelNotes: string;
  exampleInput: string;
  exampleOutput: string;
  usageNotes: string;
  changeNote: string;
  hash: string;
  license: "CC0-1.0";
  createdAt: string;
  origin: CommunityOrigin | null;
};
export type CommunityDetail = CommunityCard & {
  version: CommunityVersion;
  versions: { number: number; changeNote: string; createdAt: string }[];
};
export type CommunityPage = {
  items: CommunityCard[];
  total: number;
  page: number;
  pageSize: number;
  asOf: string;
};
export type CommunityViewer = {
  user: (CommunityAuthor & { role: "ADMIN" | "USER" }) | null;
  isOwner: boolean;
  starred: boolean;
};
export type PublicationInput = {
  purposes?: PurposeId[];
  title: string;
  summary: string;
  content: string;
  taskType: TaskType;
  language: "zh-CN" | "en" | "other";
  tags: string[];
  variables: string;
  modelNotes: string;
  exampleInput: string;
  exampleOutput: string;
  usageNotes: string;
  changeNote: string;
  authorName: string;
  authorBio: string;
  consent: boolean;
  sourceVersionId?: string;
  sourcePublicId?: string;
  sourcePublicVersion?: number;
  baseVersion?: number;
};
export type CommunitySeed = {
  descriptor?: PromptDescriptor;
  title: string;
  content: string;
  taskType: TaskType;
  sourceVersionId: string;
  origin: CommunityOrigin | null;
};
export type CommunityCopySource = {
  publicId: string;
  versionNumber: number;
  title: string;
  hash: string;
  license: "CC0-1.0";
  available: boolean;
};
export type CommunityReportCategory = "privacy" | "rights" | "spam" | "other";
export type CommunityModeration = {
  paging: {
    reports: { page: number; total: number; pageSize: number };
    stars: { page: number; total: number; pageSize: number };
    events: { page: number; total: number; pageSize: number };
  };
  reports: {
    id: string;
    publicId: string;
    title: string;
    category: CommunityReportCategory;
    detail: string;
    status: string;
    createdAt: string;
  }[];
  events: {
    id: string;
    publicId: string | null;
    action: string;
    reason: string;
    createdAt: string;
  }[];
  stars: {
    id: string;
    publicId: string;
    active: boolean;
    excluded: boolean;
    firstStarredAt: string;
  }[];
};
