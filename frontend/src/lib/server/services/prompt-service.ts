import type { PromptVersion, TaskType } from "@/lib/types";
import {
  createPrompt as createPromptRecord,
  createPromptVersion as createPromptVersionRecord,
  getPromptForEvaluation as getPromptForEvaluationRecord,
  getPromptSummary as getPromptSummaryRecord,
  getPromptVersion as getPromptVersionRecord,
  saveOptimization as saveOptimizationRecord,
} from "../repository";

export type CreatePromptInput = {
  title: string;
  taskType: TaskType;
  content: string;
  description?: string;
  manualDraft?: boolean;
  requestKey?: string;
  adoptedUseEventIds?: string[];
  descriptor?: import("@/lib/prompt-description").PromptDescriptor;
};

export type CreatePromptVersionInput = {
  descriptor?: import("@/lib/prompt-description").PromptDescriptor;
  promptId: string;
  content: string;
  title?: string;
  baseVersionId: string;
  parentVersionId?: string;
  source: string;
  adoptedUseEventIds?: string[];
  optimizationId?: string;
};

export type SaveOptimizationInput = {
  promptId: string;
  sourceVersionId: string;
  proposedContent: string;
};

function requireText(value: string, field: string) {
  if (!value.trim()) {
    throw Object.assign(new Error(`${field} is required.`), { code: "INVALID_INPUT" });
  }
}

/**
 * Application service for Prompt and PromptVersion lifecycle operations.
 * Route handlers only translate HTTP input; repository owns transactions and SQL.
 */
export async function createPrompt(input: CreatePromptInput) {
  requireText(input.title, "title");
  requireText(input.content, "content");
  return createPromptRecord({
    ...input,
    title: input.title.trim(),
    description: input.description?.trim() ?? "",
  });
}

export async function createPromptVersion(input: CreatePromptVersionInput) {
  requireText(input.promptId, "promptId");
  requireText(input.baseVersionId, "baseVersionId");
  requireText(input.content, "content");
  requireText(input.source, "source");
  return createPromptVersionRecord({
    ...input,
    title: input.title?.trim(),
    content: input.content,
    source: input.source.trim(),
  });
}

export async function getPromptSummary(promptId: string) {
  requireText(promptId, "promptId");
  return getPromptSummaryRecord(promptId);
}

export async function getPromptForEvaluation(promptId: string) {
  requireText(promptId, "promptId");
  return getPromptForEvaluationRecord(promptId);
}

export async function getPromptVersion(promptId: string, versionId: string) {
  requireText(promptId, "promptId");
  requireText(versionId, "versionId");
  return getPromptVersionRecord(promptId, versionId);
}

export async function saveOptimization(input: SaveOptimizationInput) {
  requireText(input.promptId, "promptId");
  requireText(input.sourceVersionId, "sourceVersionId");
  requireText(input.proposedContent, "proposedContent");
  return saveOptimizationRecord(input);
}

export type PromptVersionRelation = Pick<PromptVersion, "id" | "promptId" | "parentVersionId">;
