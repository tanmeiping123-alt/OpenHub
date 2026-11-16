import type {
  ModelProvider,
  ModelSelection,
  ModelStrength,
  PublicModelOption,
} from "./model-catalog";

export const PELICAN_PROMPT = "创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画";
export const PELICAN_CHALLENGE_VERSION = "pelican-svg-v1";
export type PelicanCallStatus = "QUEUED" | "PENDING" | "SUCCEEDED" | "FAILED" | "UNKNOWN";
export type PelicanPreviewStatus =
  "PENDING" | "READY" | "STATIC" | "INVALID" | "BLOCKED" | "UNSUPPORTED" | "TRUNCATED";
export type PelicanRunBlock = {
  code: string;
  modelName?: string;
  requiredTokens?: number;
  remainingTokens?: number;
  requiredCostUsd?: number;
  remainingCostUsd?: number;
  scope?: "daily" | "period" | "platform";
  resetAt?: string;
};
export type PelicanSample = {
  id: string;
  batchId: string;
  modelKey: string;
  modelName: string;
  provider: ModelProvider;
  requestedModel: string;
  resolvedModel: string | null;
  strength: ModelStrength;
  maxOutputTokens: number;
  reasoningTokenReserve: number;
  timeoutMs: number;
  generatedAt: string | null;
  startedAt?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  stopRequested?: boolean;
  canStop?: boolean;
  canDelete?: boolean;
  latencyMs: number | null;
  callStatus: PelicanCallStatus;
  previewStatus: PelicanPreviewStatus;
  previewReason: string | null;
  finishReason: string | null;
  rerunOf: string | null;
  interrupted: boolean;
  hasThumbnail: boolean;
  withdrawn: boolean;
  withdrawnReason: string | null;
};
export type PelicanBatch = {
  id: string;
  title: string;
  challengeVersion: string;
  createdAt: string;
  publishedAt: string | null;
  status: "DRAFT" | "RUNNING" | "COMPLETE" | "PUBLISHED" | "WITHDRAWN";
  samples: PelicanSample[];
};
export type PelicanListing = {
  batches: PelicanBatch[];
  models: { key: string; name: string }[];
  page: number;
  hasMore: boolean;
};
export type PelicanAdminBatch = PelicanBatch & {
  estimatedCostUsd: number;
  estimatedTokens: number;
  budgetFingerprint: string;
  canRun: boolean;
  canPublish: boolean;
  canDelete: boolean;
  blockedReason: string | null;
  runBlock: PelicanRunBlock | null;
};
export type PelicanAdminData = {
  batches: PelicanAdminBatch[];
  models: PublicModelOption[];
  page: number;
  hasMore: boolean;
};
export type PelicanCreateInput = {
  requestKey: string;
  title: string;
  selections: ModelSelection[];
};
export type PelicanPreviewSession = { sessionId: string; expiresAt: string; paused: boolean };
