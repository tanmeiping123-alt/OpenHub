import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient } from "pg";

export const REQUIRED_MIGRATION = "039_external_account_identities.sql";
export const demoUserId = "usr_local_demo_01";
type Scope = { connectionString: string; pool?: Pool; ready?: Promise<void> };
const context = new AsyncLocalStorage<Scope>();

function scope() {
  const value = context.getStore();
  if (!value) throw new Error("PostgreSQL requires an active Worker request.");
  return value;
}
export function getPool(): Pool {
  const state = scope();
  return state.pool ??= new Pool({
    connectionString: state.connectionString, max: 3,
    connectionTimeoutMillis: 10_000, idleTimeoutMillis: 1000,
    application_name: "openhub-worker",
  });
}
export async function ensureDatabaseReady() {
  const state = scope();
  state.ready ??= (async () => {
    const result = await getPool().query("SELECT migration_name FROM schema_migrations WHERE migration_name=$1", [REQUIRED_MIGRATION]);
    if (!result.rowCount) throw new Error("Apply database migrations before deploying the Worker.");
  })();
  await state.ready;
}
export async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensureDatabaseReady();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '10s'");
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

// Keep the database scope alive until streamed RSC/API output is consumed.
// A socket created by another request is never reused.
export function withWorkerDatabase(connectionString: string, work: () => Promise<Response>): Promise<Response> {
  const state: Scope = { connectionString };
  let cleanup: Promise<void> | undefined;
  const close = () => cleanup ??= state.pool?.end() ?? Promise.resolve();
  return context.run(state, async () => {
    try {
      const response = await work();
      if (!response.body) { await close(); return response; }
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          return context.run(state, async () => {
            try {
              const result = await reader.read();
              if (result.done) { await close(); controller.close(); }
              else controller.enqueue(result.value);
            } catch (error) { await close(); controller.error(error); }
          });
        },
        async cancel(reason) { try { await reader.cancel(reason); } finally { await close(); } },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { await close(); throw error; }
  });
}
