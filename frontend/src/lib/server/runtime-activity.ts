import "server-only";

const globals = globalThis as typeof globalThis & { __openHubBackgroundWork?: Set<symbol> };
const active = (globals.__openHubBackgroundWork ??= new Set<symbol>());

export function beginBackgroundWork() {
  const operation = Symbol();
  active.add(operation);
  return () => { active.delete(operation); };
}

export function hasBackgroundWork() {
  return active.size > 0;
}
