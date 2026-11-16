// Explicit, operator-supplied session only. Never print the token or persist it.
export async function liveSmokeAuth(baseUrl) {
  const url = new URL(baseUrl);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Live smoke requires a loopback base URL.");
  const token = process.env.PROMPTMASTER_MODEL_SMOKE_SESSION_TOKEN;
  if (!token || !/^[a-f0-9]{64}$/.test(token))
    throw new Error(
      "Set PROMPTMASTER_MODEL_SMOKE_SESSION_TOKEN to an active signed-in account session using your private local environment.",
    );
  const headers = {
    Origin: url.origin,
    Cookie: `pm_session=${token}`,
    "Content-Type": "application/json",
  };
  const response = await fetch(`${url.origin}/api/auth/session`, { headers, redirect: "error" });
  const session = response.ok ? await response.json() : null;
  if (!session?.user?.id)
    throw new Error("Live smoke session is unavailable or expired; no supplier call was made.");
  return headers;
}
