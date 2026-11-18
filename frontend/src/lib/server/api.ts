import { NextResponse } from "next/server";
import { AccountError } from "./accounts";

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function guardLocalDemoApi(request: Request, requireSameOrigin = false) {
  const host = request.headers.get("host")?.toLowerCase() ?? "";
  const hostname = host.replace(/:\d+$/, "");
  const cloud = ["cloudflare-container", "cloudflare-workers"].includes(process.env.PROMPTMASTER_DEPLOYMENT_MODE ?? "");
  let cloudOrigin = "";
  if (cloud) {
    try {
      const configured = process.env.OPENHUB_PUBLIC_ORIGIN ?? "";
      const url = new URL(configured);
      if (url.protocol === "https:" && configured === url.origin) cloudOrigin = url.origin;
    } catch {
      // An absent or malformed cloud origin must never enable public API access.
    }
  }
  if (
    process.env.PROMPTMASTER_DEMO_API_ENABLED !== "true" ||
    (cloud
      ? !cloudOrigin || host !== new URL(cloudOrigin).host ||
        request.headers.get("x-forwarded-host") !== host ||
        request.headers.get("x-forwarded-proto") !== "https"
      : process.env.NODE_ENV === "production" || !loopbackHosts.has(hostname))
  ) {
    return NextResponse.json({ error: "DEMO_API_DISABLED" }, { status: 404 });
  }

  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ error: "ORIGIN_REJECTED" }, { status: 403 });
  }

  if (requireSameOrigin) {
    const origin = request.headers.get("origin");
    let originHost = "";
    let sameProtocol = false;
    try {
      originHost = origin ? new URL(origin).host.toLowerCase() : "";
      sameProtocol = !!origin && new URL(origin).protocol === new URL(request.url).protocol;
    } catch {
      originHost = "";
    }
    if (cloud ? origin !== cloudOrigin : !originHost || originHost !== host || !sameProtocol) {
      return NextResponse.json({ error: "ORIGIN_REJECTED" }, { status: 403 });
    }
  }

  return null;
}

export function apiError(error: unknown) {
  if (error instanceof AccountError)
    return NextResponse.json({ error: error.code }, { status: error.status });
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (code === "INVALID_INPUT" || code === "EVALUATION_STATE_CONFLICT") {
    return NextResponse.json({ error: code }, { status: 400 });
  }
  if (code === "VERSION_CONFLICT" || code === "IDEMPOTENCY_CONFLICT") {
    return NextResponse.json({ error: code }, { status: 409 });
  }
  if (code === "23505" || code === "23503" || code === "23514") {
    return NextResponse.json({ error: "DATA_CONFLICT" }, { status: 409 });
  }
  console.error("PromptMaster demo API request failed", error);
  return NextResponse.json({ error: "DEMO_API_UNAVAILABLE" }, { status: 503 });
}

export function validAdoptionIds(value: unknown): value is string[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= 4 &&
      value.every((v) => typeof v === "string" && /^sue_[a-f0-9-]{36}$/.test(v)))
  );
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

export function isScore(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100)
  );
}

export function validLayer(value: unknown) {
  if (!isRecord(value) || !boundedText(value.status, 80) || !isScore(value.score)) return false;
  if (value.grade !== null && typeof value.grade !== "string") return false;
  if (!Array.isArray(value.dimensions)) return false;
  return value.dimensions.every((dimension) => {
    if (!isRecord(dimension)) return false;
    return (
      typeof dimension.name === "string" &&
      typeof dimension.weight === "number" &&
      Number.isFinite(dimension.weight) &&
      isScore(dimension.score) &&
      typeof dimension.state === "string" &&
      typeof dimension.reason === "string"
    );
  });
}

export function evaluationPayloadError(taskType: string, body: unknown) {
  if (
    !isRecord(body) ||
    !boundedText(body.versionId, 200) ||
    !boundedText(body.rubricVersion, 200) ||
    !validLayer(body.layer1) ||
    !validLayer(body.layer2) ||
    "totalScore" in body
  ) {
    return "INVALID_EVALUATION_INPUT";
  }
  const layer2 = body.layer2;
  if (!isRecord(layer2)) return "INVALID_EVALUATION_INPUT";
  if (
    taskType === "General" &&
    !(
      layer2.status === "NOT_AVAILABLE" &&
      layer2.score === null &&
      layer2.grade === null &&
      Array.isArray(layer2.dimensions) &&
      layer2.dimensions.length === 0
    )
  ) {
    return "GENERAL_LAYER2_CONTRACT_VIOLATION";
  }
  if (
    ["Data Analysis", "Business", "Research", "AI Agent"].includes(taskType) &&
    layer2.score !== null
  ) {
    return "TASK_RUBRIC_PENDING";
  }
  return null;
}

export function safeJson(body: unknown) {
  return JSON.stringify(body);
}
