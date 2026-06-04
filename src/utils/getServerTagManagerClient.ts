import { google } from "googleapis";
import { refreshUpstreamAuthToken } from "./authorizeUtils";

let cachedToken: { access_token: string; expiresAt: number } | null = null;

async function getAccessToken(env: Env): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 300_000) {
    return cachedToken.access_token;
  }
  const [tokenResult, errMessage] = await refreshUpstreamAuthToken({
    upstreamUrl: "https://oauth2.googleapis.com/token",
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    refreshToken: env.GTM_REFRESH_TOKEN,
  });
  if (errMessage || !tokenResult) {
    throw new Error("Failed to refresh Google access token using GTM_REFRESH_TOKEN");
  }
  cachedToken = {
    access_token: tokenResult.access_token,
    expiresAt: Date.now() + (tokenResult.expires_in ?? 3600) * 1000,
  };
  return cachedToken.access_token;
}

export async function getServerTagManagerClient(env: Env) {
  if (!env.GTM_REFRESH_TOKEN) {
    throw new Error("GTM_REFRESH_TOKEN not configured — set it in Coolify env vars");
  }
  const accessToken = await getAccessToken(env);
  return google.tagmanager({
    version: "v2",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}
