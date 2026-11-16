import { withIdentity } from "@/lib/server/authenticated-route";
import { randomUUID } from "node:crypto";
import { validateCalibrationReport } from "@/lib/calibration";
import type { EvaluationReport, LayerState } from "@/lib/types";
import { apiError, evaluationPayloadError, guardLocalDemoApi, isRecord } from "@/lib/server/api";
import { getPromptForEvaluation, getPromptVersion } from "@/lib/server/services/prompt-service";
import { saveEvaluationReport } from "@/lib/server/services/evaluation-service";

export const runtime = "nodejs";

async function handlePOST(request: Request, context: { params: Promise<{ promptId: string }> }) {
  const blocked = guardLocalDemoApi(request, true);
  if (blocked) return blocked;
  try {
    const body: unknown = await request.json();
    if (!isRecord(body))
      return Response.json({ error: "INVALID_EVALUATION_INPUT" }, { status: 400 });
    const { promptId } = await context.params;
    const prompt = await getPromptForEvaluation(promptId);
    if (!prompt) return Response.json({ error: "PROMPT_NOT_FOUND" }, { status: 404 });
    const validationError = evaluationPayloadError(prompt.taskType, body);
    if (validationError)
      return Response.json(
        { error: validationError },
        { status: validationError === "INVALID_EVALUATION_INPUT" ? 400 : 422 },
      );
    const versionId = body.versionId as string;
    const version = await getPromptVersion(promptId, versionId);
    if (!version) return Response.json({ error: "PROMPT_VERSION_NOT_FOUND" }, { status: 404 });
    const layer2 = body.layer2 as LayerState;
    const layer3: LayerState = { status: "NOT_EXECUTED", score: null, grade: null, dimensions: [] };
    if (
      body.source !== undefined &&
      body.source !== "MOCK / SIMULATED" &&
      body.source !== "LOCAL_HUMAN_CALIBRATION"
    ) {
      return Response.json({ error: "INVALID_EVALUATION_SOURCE" }, { status: 400 });
    }
    const source =
      body.source === "LOCAL_HUMAN_CALIBRATION" ? "LOCAL_HUMAN_CALIBRATION" : "MOCK / SIMULATED";
    const calibration = body.calibration;

    const report: EvaluationReport = {
      id: `evr_${randomUUID()}`,
      promptId,
      versionId,
      createdAt: new Date().toISOString(),
      source,
      rubricVersion: body.rubricVersion as string,
      layer1: body.layer1 as LayerState,
      layer2,
      layer3,
      ...(source === "LOCAL_HUMAN_CALIBRATION"
        ? { calibration: calibration as EvaluationReport["calibration"] }
        : {}),
    };
    if (source === "LOCAL_HUMAN_CALIBRATION" && !validateCalibrationReport(report, version)) {
      return Response.json({ error: "INVALID_CALIBRATION_INPUT" }, { status: 422 });
    }
    const saved = await saveEvaluationReport(report);
    if (!saved) return Response.json({ error: "PROMPT_VERSION_NOT_FOUND" }, { status: 404 });
    return Response.json(report, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}

export const POST = withIdentity(handlePOST);
