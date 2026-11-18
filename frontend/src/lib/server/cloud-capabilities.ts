import { AccountError } from "./account-errors";

export function requirePelicanRuntime() {
  if (process.env.PROMPTMASTER_DEPLOYMENT_MODE === "cloudflare-workers")
    throw new AccountError("PELICAN_UNAVAILABLE_ON_FREE_CLOUD", 503);
}
