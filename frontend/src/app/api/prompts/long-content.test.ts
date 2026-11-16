import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as create } from "./route";
import { POST as version } from "./[promptId]/versions/route";
import { POST as optimization } from "./[promptId]/optimizations/route";
import {
  createPrompt,
  createPromptVersion,
  saveOptimization,
} from "@/lib/server/services/prompt-service";
import { sessionActor } from "@/lib/server/accounts";

vi.mock("@/lib/server/services/prompt-service", () => ({
  createPrompt: vi.fn(),
  createPromptVersion: vi.fn(),
  saveOptimization: vi.fn(),
}));
vi.mock("@/lib/server/accounts", async (original) => ({
  ...(await original<typeof import("@/lib/server/accounts")>()),
  sessionActor: vi.fn(),
}));
function request(body: unknown) {
  return new Request("http://127.0.0.1:3000/api/prompts", {
    method: "POST",
    headers: {
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PROMPTMASTER_DEMO_API_ENABLED", "true");
  vi.stubEnv("NODE_ENV", "development");
  vi.mocked(sessionActor).mockResolvedValue({
    id: "usr_fixture",
    role: "USER",
    email: "fixture@example.test",
  });
  vi.mocked(createPrompt).mockResolvedValue({ promptId: "p", versionId: "v" } as never);
  vi.mocked(createPromptVersion).mockResolvedValue({ versionId: "v2" } as never);
  vi.mocked(saveOptimization).mockResolvedValue({} as never);
});
const cases = [
  {
    name: "copy or import",
    run: (content: string) => create(request({ title: "Large output", content })),
  },
  {
    name: "edit or adopt",
    run: (content: string) =>
      version(request({ content, baseVersionId: "v", source: "USER_EDIT" }), {
        params: Promise.resolve({ promptId: "p" }),
      }),
  },
  {
    name: "optimization",
    run: (content: string) =>
      optimization(request({ proposedContent: content, sourceVersionId: "v" }), {
        params: Promise.resolve({ promptId: "p" }),
      }),
  },
];
describe("large generated prompt lifecycle", () => {
  it.each(cases)("allows $name beyond the previous 200k character limit", async ({ run }) => {
    expect((await run("x".repeat(200001))).status).toBe(201);
  });
  it.each(cases)("still bounds $name input", async ({ run }) => {
    expect((await run("x".repeat(4000001))).status).toBe(400);
    expect(createPrompt).not.toHaveBeenCalled();
    expect(createPromptVersion).not.toHaveBeenCalled();
    expect(saveOptimization).not.toHaveBeenCalled();
  });
});
