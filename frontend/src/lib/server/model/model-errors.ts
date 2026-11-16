import type { ProviderGenerateResult } from "./model-types";

export class ModelServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number,
    public readonly retryable = false,
    public readonly executionId?: string,
    public readonly providerResult?: ProviderGenerateResult,
  ) {
    super(message);
    this.name = "ModelServiceError";
  }

  withExecutionId(executionId: string) {
    return new ModelServiceError(
      this.code,
      this.message,
      this.httpStatus,
      this.retryable,
      executionId,
      this.providerResult,
    );
  }
}

export function toPublicModelError(error: unknown) {
  if (error instanceof ModelServiceError) {
    return {
      code: error.code,
      message: error.message,
      status: error.httpStatus,
      executionId: error.executionId,
    };
  }
  return {
    code: "MODEL_SERVICE_UNAVAILABLE",
    message: "The live model request could not be completed.",
    status: 503,
    executionId: undefined,
  };
}
