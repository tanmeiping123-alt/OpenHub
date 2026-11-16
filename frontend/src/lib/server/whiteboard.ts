import "server-only";
import { AccountError } from "./accounts";
import { isRecord } from "./api";
import { withTransaction } from "./db";
import { workspaceOwnerId } from "./identity-context";

export const MAX_WHITEBOARD_BYTES = 24 * 1024 * 1024;
const emptyScene = () => ({ elements: [], appState: {}, files: {} });
const elementTypes = new Set([
  "rectangle",
  "diamond",
  "ellipse",
  "line",
  "arrow",
  "freedraw",
  "text",
  "image",
  "frame",
  "magicframe",
  "embeddable",
  "iframe",
  "selection",
  "stickynote",
]);

function validElements(elements: unknown): boolean {
  return (
    Array.isArray(elements) &&
    elements.length <= 20000 &&
    elements.every(
      (e) =>
        isRecord(e) &&
        typeof e.id === "string" &&
        e.id.length > 0 &&
        e.id.length <= 200 &&
        typeof e.type === "string" &&
        elementTypes.has(e.type) &&
        [e.x, e.y, e.width, e.height].every((v) => typeof v === "number" && Number.isFinite(v)),
    )
  );
}

export function parseWhiteboard(value: unknown) {
  if (
    !isRecord(value) ||
    Object.keys(value).some((k) => !["ownerId", "revision", "scene", "libraryItems"].includes(k)) ||
    typeof value.ownerId !== "string" ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0 ||
    !isRecord(value.scene) ||
    !validElements(value.scene.elements) ||
    !isRecord(value.scene.appState) ||
    !isRecord(value.scene.files) ||
    Object.keys(value.scene.files).length > 1000 ||
    !Array.isArray(value.libraryItems) ||
    value.libraryItems.length > 1000
  ) {
    throw new AccountError("INVALID_WHITEBOARD");
  }
  const scene = value.scene;
  for (const [id, file] of Object.entries(scene.files as Record<string, unknown>)) {
    if (
      !isRecord(file) ||
      file.id !== id ||
      id.length > 200 ||
      typeof file.mimeType !== "string" ||
      ![
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/svg+xml",
        "image/avif",
        "image/bmp",
      ].includes(file.mimeType) ||
      typeof file.dataURL !== "string" ||
      !file.dataURL.startsWith(`data:${file.mimeType};base64,`) ||
      typeof file.created !== "number" ||
      !Number.isFinite(file.created)
    ) {
      throw new AccountError("INVALID_WHITEBOARD");
    }
  }
  for (const item of value.libraryItems) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      item.id.length > 200 ||
      !["published", "unpublished"].includes(String(item.status)) ||
      typeof item.created !== "number" ||
      !validElements(item.elements)
    )
      throw new AccountError("INVALID_WHITEBOARD");
  }
  return {
    ownerId: value.ownerId,
    revision: value.revision as number,
    scene,
    libraryItems: value.libraryItems,
  };
}

export function verifyWhiteboardOwner(expectedOwner: string | null) {
  const ownerId = workspaceOwnerId();
  if (expectedOwner && expectedOwner !== ownerId)
    throw new AccountError("WHITEBOARD_ACCOUNT_CHANGED", 409);
  return ownerId;
}

export async function readWhiteboard(expectedOwner: string | null) {
  const ownerId = verifyWhiteboardOwner(expectedOwner);
  return withTransaction(async (c) => {
    const { rows } = await c.query(
      "SELECT revision,scene,library_items,updated_at FROM private_whiteboards WHERE owner_user_id=$1",
      [ownerId],
    );
    const row = rows[0];
    return {
      ownerId,
      visibility: "PRIVATE",
      revision: row?.revision ?? 0,
      scene: row?.scene ?? emptyScene(),
      libraryItems: row?.library_items ?? [],
      updatedAt: row?.updated_at ?? null,
    };
  });
}

export async function saveWhiteboard(value: ReturnType<typeof parseWhiteboard>) {
  const ownerId = workspaceOwnerId();
  if (value.ownerId !== ownerId) throw new AccountError("WHITEBOARD_ACCOUNT_CHANGED", 409);
  return withTransaction(async (c) => {
    await c.query(
      "INSERT INTO private_whiteboards(owner_user_id) VALUES($1) ON CONFLICT DO NOTHING",
      [ownerId],
    );
    const { rows } = await c.query(
      `UPDATE private_whiteboards SET scene=$2::jsonb,library_items=$3::jsonb,revision=revision+1,updated_at=now()
       WHERE owner_user_id=$1 AND revision=$4 RETURNING revision,updated_at`,
      [ownerId, JSON.stringify(value.scene), JSON.stringify(value.libraryItems), value.revision],
    );
    if (!rows.length) throw new AccountError("WHITEBOARD_VERSION_CONFLICT", 409);
    return { revision: rows[0].revision, updatedAt: rows[0].updated_at };
  });
}
