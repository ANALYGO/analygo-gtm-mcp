import { google } from "googleapis";
import { refreshUpstreamAuthToken } from "./authorizeUtils";
import { readRefreshTokenFromKV } from "./kvTokenStore";

let cachedToken: { access_token: string; expiresAt: number } | null = null;

async function getAccessToken(env: Env, perUserAccessToken?: string): Promise<string> {
  // Tier 1: In-memory cache (existing, fast path)
  if (cachedToken && Date.now() < cachedToken.expiresAt - 300_000) {
    return cachedToken.access_token;
  }

  // Tier 1.5: Per-user access token via X-Google-Access-Token header
  // Used by Aegis when a user's own Google token is available from UsersLog.
  // Call GTM API directly with it — no refresh needed (caller handles that).
  if (perUserAccessToken) {
    return perUserAccessToken;
  }

  // Tier 2: Env var GTM_REFRESH_TOKEN (backward-compatible)
  if (env.GTM_REFRESH_TOKEN) {
    const [tokenResult, errMessage] = await refreshUpstreamAuthToken({
      upstreamUrl: "https://oauth2.googleapis.com/token",
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      refreshToken: env.GTM_REFRESH_TOKEN,
    });
    if (tokenResult && !errMessage) {
      cachedToken = {
        access_token: tokenResult.access_token,
        expiresAt: Date.now() + (tokenResult.expires_in ?? 3600) * 1000,
      };
      return cachedToken.access_token;
    }
    console.warn(
      `[GTM] GTM_REFRESH_TOKEN refresh failed (${errMessage}), falling through to KV tier`,
    );
  }

  // Tier 3: KV-stored refresh token (new, self-healing)
  const kvRefreshToken = await readRefreshTokenFromKV(env.OAUTH_KV);
  if (kvRefreshToken) {
    const [tokenResult, errMessage] = await refreshUpstreamAuthToken({
      upstreamUrl: "https://oauth2.googleapis.com/token",
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      refreshToken: kvRefreshToken,
    });
    if (tokenResult && !errMessage) {
      cachedToken = {
        access_token: tokenResult.access_token,
        expiresAt: Date.now() + (tokenResult.expires_in ?? 3600) * 1000,
      };
      return cachedToken.access_token;
    }
    console.error(`[GTM] KV refresh token refresh failed: ${errMessage}`);
    throw new Error(
      "Google refresh failed: refresh token from KV is expired or revoked. Re-authenticate via MCP OAuth flow.",
    );
  }

  // No refresh token available from any tier
  throw new Error(
    "No refresh token available. Set GTM_REFRESH_TOKEN or authenticate via MCP at least once.",
  );
}

export async function getServerTagManagerClient(
  env: Env,
  perUserAccessToken?: string,
) {
  const accessToken = await getAccessToken(env, perUserAccessToken);
  return google.tagmanager({
    version: "v2",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}
