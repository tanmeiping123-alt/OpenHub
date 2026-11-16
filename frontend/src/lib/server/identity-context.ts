import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { AccountError } from "./account-errors";
export type Actor = { id: string; email: string; role: "ADMIN" | "USER" };
const globals = globalThis as typeof globalThis & {
  __accountContext?: AsyncLocalStorage<Actor | null>;
};
export const accountContext = (globals.__accountContext ??= new AsyncLocalStorage<Actor | null>());
export function currentActor() {
  return accountContext.getStore() ?? null;
}
export function workspaceOwnerId() {
  const actor = currentActor();
  if (!actor) throw new AccountError("AUTH_REQUIRED", 401);
  return actor.id;
}
