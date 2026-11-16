export function validateCloudEnvironment(env) {
  if (env.PROMPTMASTER_DEPLOYMENT_MODE !== "cloudflare-container" || env.PROMPTMASTER_DEMO_API_ENABLED !== "true") {
    throw new Error("Cloud startup requires cloudflare-container mode and enabled authenticated APIs.");
  }
  const origin = new URL(env.OPENHUB_PUBLIC_ORIGIN || "invalid:");
  if (origin.protocol !== "https:" || origin.origin !== env.OPENHUB_PUBLIC_ORIGIN) {
    throw new Error("OPENHUB_PUBLIC_ORIGIN must be the public HTTPS origin without a path.");
  }
  const database = new URL(env.DATABASE_URL || "invalid:");
  if (!["postgres:", "postgresql:"].includes(database.protocol) || !database.hostname ||
      !database.username || !database.pathname.slice(1) || /YOUR_|REPLACE_/i.test(database.password)) {
    throw new Error("A real PostgreSQL DATABASE_URL is required for cloud startup.");
  }
  if (!env.OPENHUB_INTERNAL_TOKEN) throw new Error("The container controller token is missing.");
}

export function assertAccountBootstrapTarget(databaseUrl, cloudRequested, deploymentMode) {
  const url = new URL(databaseUrl || "invalid:");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.pathname === "/promptmaster_dev";
  if (local && !cloudRequested) return;
  if (cloudRequested && deploymentMode === "cloudflare-container" &&
      ["postgres:", "postgresql:"].includes(url.protocol) && url.hostname && url.pathname.slice(1)) return;
  throw new Error("Account bootstrap requires the local demo database or explicit --cloud selection in cloudflare-container mode.");
}
