// Keep runtime bindings explicit: no unrelated account secrets enter the container.
const settingKeys = [
  "DATABASE_URL", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL",
  "DEEPSEEK_PRODUCT_VERSION", "SILICONFLOW_API_KEY", "SILICONFLOW_BASE_URL",
  "SILICONFLOW_MODEL_TIMEOUT_MS", "PROMPTMASTER_MODEL_MODE", "PROMPTMASTER_MODEL_PROVIDER",
  "PROMPTMASTER_MODEL_TIMEOUT_MS", "PROMPTMASTER_DEEPSEEK_THINKING_TIMEOUT_MS",
  "PROMPTMASTER_MODEL_MAX_RETRIES", "PROMPTMASTER_PELICAN_CONCURRENCY",
  "PROMPTMASTER_MODEL_DAILY_TOKEN_LIMIT", "PROMPTMASTER_COMMUNITY_PUBLISH_DAILY_LIMIT",
  "PROMPTMASTER_MODEL_DAILY_COST_LIMIT_USD", "PROMPTMASTER_MODEL_PRICING_WINDOW",
  "PROMPTMASTER_PAYMENT_ENABLED", "PROMPTMASTER_PAYMENT_QR_PATH",
  "PROMPTMASTER_PAYMENT_RECEIVER_ACCOUNT", "PROMPTMASTER_PAYMENT_RECEIVER_HINT",
  "PROMPTMASTER_PAYMENT_REFUND_CONTACT", "PROMPTMASTER_WECHAT_PAYMENT_ENABLED",
  "PROMPTMASTER_WECHAT_PAYMENT_QR_PATH", "PROMPTMASTER_WECHAT_PAYMENT_RECEIVER_ACCOUNT",
  "PROMPTMASTER_WECHAT_PAYMENT_RECEIVER_HINT", "PROMPTMASTER_WECHAT_PAYMENT_REFUND_CONTACT",
];

export function publicOrigin(requestUrl, configured) {
  const requested = new URL(requestUrl);
  const expected = configured || requested.origin;
  const origin = new URL(expected);
  if (origin.protocol !== "https:" || expected !== origin.origin || requested.origin !== origin.origin) {
    throw new Error("OpenHub requires its configured public HTTPS origin.");
  }
  return origin.origin;
}

export function containerEnvironment(env, origin, token) {
  if (!env.DATABASE_URL) throw new Error("Configure the DATABASE_URL Worker secret before deployment.");
  const database = new URL(env.DATABASE_URL);
  if (!["postgres:", "postgresql:"].includes(database.protocol)) throw new Error("DATABASE_URL must use PostgreSQL.");
  const result = {};
  for (const key of settingKeys) {
    if (typeof env[key] === "string" && env[key]) result[key] = env[key];
  }
  return {
    ...result,
    NODE_ENV: "production", HOSTNAME: "0.0.0.0", PORT: "3000",
    PROMPTMASTER_DEMO_API_ENABLED: "true",
    PROMPTMASTER_DEPLOYMENT_MODE: "cloudflare-container",
    OPENHUB_PUBLIC_ORIGIN: publicOrigin(origin), OPENHUB_INTERNAL_TOKEN: token,
  };
}

export function forwardedRequest(request) {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete("forwarded");
  headers.delete("x-openhub-internal-token");
  headers.set("host", url.host);
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.slice(0, -1));
  headers.delete("x-forwarded-port");
  return new Request(request, { headers });
}
