import { bootstrap as bootstrapRepository } from "../repository";

/** Initializes idempotent fixtures and returns one consistent read snapshot. */
export async function bootstrapDemoWorkspace() {
  return bootstrapRepository();
}
