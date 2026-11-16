import {
  getSnapshot,
  savePlaygroundRun as savePlaygroundRunRecord,
  setFavorite as setFavoriteRecord,
  setLibraryItem as setLibraryItemRecord,
  updateProfileName as updateProfileNameRecord,
} from "../repository";

export async function getWorkspaceSnapshot() {
  return getSnapshot();
}

export async function setLibraryItem(promptId: string, saved: boolean) {
  return setLibraryItemRecord(promptId, saved);
}

export async function setFavorite(promptId: string, favorite: boolean) {
  return setFavoriteRecord(promptId, favorite);
}

export async function savePlaygroundRun(input: {
  promptId: string;
  versionId: string;
  outputs: { name: string; text: string }[];
}) {
  return savePlaygroundRunRecord(input);
}

export async function updateProfileName(name: string) {
  const normalized = name.trim();
  if (!normalized) {
    throw Object.assign(new Error("displayName is required."), { code: "INVALID_INPUT" });
  }
  return updateProfileNameRecord(normalized);
}
