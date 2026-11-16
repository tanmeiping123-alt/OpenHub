import { boundedJson, withIdentity } from "@/lib/server/authenticated-route";
import {
  MAX_WHITEBOARD_BYTES,
  parseWhiteboard,
  readWhiteboard,
  saveWhiteboard,
  verifyWhiteboardOwner,
} from "@/lib/server/whiteboard";

export const runtime = "nodejs";
export const GET = withIdentity(async (request: Request) => {
  const owner = request.headers.get("x-whiteboard-owner");
  return Response.json(
    request.headers.get("x-whiteboard-check") === "identity"
      ? { ownerId: verifyWhiteboardOwner(owner) }
      : await readWhiteboard(owner),
  );
});
export const PUT = withIdentity(async (request: Request) =>
  Response.json(
    await saveWhiteboard(parseWhiteboard(await boundedJson(request, MAX_WHITEBOARD_BYTES))),
  ),
);
