import { apiError, guardLocalDemoApi } from "@/lib/server/api";
import { setFavorite } from "@/lib/server/services/workspace-service";
import { withIdentity } from "@/lib/server/authenticated-route";

export const runtime = "nodejs";

async function update(
  request: Request,
  context: { params: Promise<{ promptId: string }> },
  favorite: boolean,
) {
  const blocked = guardLocalDemoApi(request, true);
  if (blocked) return blocked;
  try {
    const { promptId } = await context.params;
    const exists = await setFavorite(promptId, favorite);
    if (!exists) return Response.json({ error: "PROMPT_NOT_FOUND" }, { status: 404 });
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
}

export const PUT = withIdentity(
  async (request: Request, context: { params: Promise<{ promptId: string }> }) => {
    return update(request, context, true);
  },
);

export const DELETE = withIdentity(
  async (request: Request, context: { params: Promise<{ promptId: string }> }) => {
    return update(request, context, false);
  },
);
