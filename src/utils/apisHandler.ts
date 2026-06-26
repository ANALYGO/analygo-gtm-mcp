import type {
  AuthRequest,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { Context, Hono } from "hono";
import {
  fetchUpstreamAuthToken,
  getUpstreamAuthorizeUrl,
  Props,
} from "./authorizeUtils";
import { getServerTagManagerClient } from "./getServerTagManagerClient";
import { readRefreshTokenFromKV, writeRefreshTokenToKV } from "./kvTokenStore";
import { renderMainPage } from "./renderMainPage";
import { renderPrivacyPage } from "./renderPrivacyPage";
import { renderTermsPage } from "./renderTermsPage";
import {
  clientIdAlreadyApproved,
  parseRedirectApproval,
  renderApprovalDialog,
} from "./workersOAuthUtils";

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

app.get("/register", async (c) => {
  return c.json({
    registration_endpoint: new URL("/register", c.req.url).href,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
  });
});

app.get("/authorize", async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const { clientId } = oauthReqInfo;

  if (!clientId) {
    return c.text("Invalid request", 400);
  }

  if (
    await clientIdAlreadyApproved(
      c.req.raw,
      oauthReqInfo.clientId,
      c.env.COOKIE_ENCRYPTION_KEY,
    )
  ) {
    return redirectToGoogle(c, oauthReqInfo);
  }

  return renderApprovalDialog(c.req.raw, {
    client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
    server: {
      name: "STAPE.AI",
      description: "",
    },
    state: { oauthReqInfo },
  });
});

app.post("/authorize", async (c) => {
  const { state, headers } = await parseRedirectApproval(
    c.req.raw,
    c.env.COOKIE_ENCRYPTION_KEY,
  );

  if (!state.oauthReqInfo) {
    return c.text("Invalid request", 400);
  }

  return redirectToGoogle(c, state.oauthReqInfo, headers);
});

async function redirectToGoogle(
  c: Context,
  oauthReqInfo: AuthRequest,
  headers: Record<string, string> = {},
) {
  console.log(`/redirectToGoogle oauthReqInfo`, oauthReqInfo);

  const scopes = [
    "email",
    "profile",
    "https://www.googleapis.com/auth/tagmanager.manage.accounts",
    "https://www.googleapis.com/auth/tagmanager.edit.containers",
    "https://www.googleapis.com/auth/tagmanager.delete.containers",
    "https://www.googleapis.com/auth/tagmanager.edit.containerversions",
    "https://www.googleapis.com/auth/tagmanager.manage.users",
    "https://www.googleapis.com/auth/tagmanager.publish",
    "https://www.googleapis.com/auth/tagmanager.readonly",
  ];
  return new Response(null, {
    status: 302,
    headers: {
      ...headers,
      location: getUpstreamAuthorizeUrl({
        upstreamUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        scope: scopes.join(" "),
        clientId: c.env.GOOGLE_CLIENT_ID,
        redirectUri: new URL("/callback", c.req.raw.url).href,
        state: btoa(JSON.stringify(oauthReqInfo)),
        hostedDomain: c.env.HOSTED_DOMAIN,
        hasRefreshToken: false,
      }),
    },
  });
}

app.get("/callback", async (c) => {
  // Get the oathReqInfo out of KV
  const oauthReqInfo = JSON.parse(
    atob(c.req.query("state") as string),
  ) as AuthRequest;

  if (!oauthReqInfo.clientId) {
    return c.text("Invalid state", 400);
  }

  const code = c.req.query("code");

  if (!code) {
    return c.text("Missing code", 400);
  }

  const [tokenResult, googleErrResponse] = await fetchUpstreamAuthToken({
    upstreamUrl: "https://oauth2.googleapis.com/token",
    clientId: c.env.GOOGLE_CLIENT_ID,
    clientSecret: c.env.GOOGLE_CLIENT_SECRET,
    code,
    redirectUri: new URL("/callback", c.req.url).href,
    grantType: "authorization_code",
  });

  if (googleErrResponse) {
    return googleErrResponse;
  }

  const userResponse = await fetch(
    "https://www.googleapis.com/oauth2/v2/userinfo",
    {
      headers: {
        Authorization: `Bearer ${tokenResult?.access_token}`,
      },
    },
  );

  if (!userResponse.ok) {
    return c.text(
      `Failed to fetch user info: ${await userResponse.text()}`,
      500,
    );
  }

  const { id, name, email } = (await userResponse.json()) as {
    id: string;
    name: string;
    email: string;
  };

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: id,
    metadata: {
      label: name,
    },
    scope: oauthReqInfo.scope,
    props: {
      name,
      email,
      accessToken: tokenResult.access_token,
      refreshToken: tokenResult.refresh_token,
      expiresAt:
        Math.floor(Date.now() / 1000) + (tokenResult.expires_in ?? 3600),
      clientId: oauthReqInfo.clientId,
      userId: id,
    } satisfies Props,
  });

  if (tokenResult.refresh_token) {
    await writeRefreshTokenToKV(c.env.OAUTH_KV, tokenResult.refresh_token);
  }

  const url = new URL(redirectTo);
  url.searchParams.set("email", email);
  return Response.redirect(url.toString());
});

app.get("/remove", async (c) => {
  const userId = c.req.query("userId");
  const clientId = c.req.query("clientId");
  const accessToken = c.req.query("accessToken");

  if (!userId || !clientId || !accessToken) {
    return new Response("Invalid request", {
      status: 400,
    });
  }

  const listUserGrants = await c.env.OAUTH_PROVIDER.listUserGrants(userId);
  const revokeGrantRequests = listUserGrants.items.map((item) => {
    return c.env.OAUTH_PROVIDER.revokeGrant(item.id, item.userId);
  });

  await Promise.all(revokeGrantRequests);
  await c.env.OAUTH_PROVIDER.deleteClient(clientId);
  await fetch(`https://oauth2.googleapis.com/revoke?token=${accessToken}`, {
    method: "POST",
    headers: {
      "Content-type": "application/x-www-form-urlencoded",
    },
  });

  return new Response("OK", {
    status: 200,
  });
});

function requireApiKey(c: Context) {
  const auth = c.req.header("X-Internal-Auth") || "";
  if (!auth || auth !== c.env.GTM_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }
}

/** Read per-user Google access token from request header, if present. */
function getPerUserAccessToken(c: Context): string | undefined {
  return c.req.header("X-Google-Access-Token") || undefined;
}

// GET /api/gtm/token — return the server-level refresh token from KV.
// Called by the Aegis backend's token_manager to obtain the refresh
// token and exchange it for an access token.
app.get("/api/gtm/token", async (c) => {
  const authErr = requireApiKey(c);
  if (authErr) return authErr;

  const refreshToken = await readRefreshTokenFromKV(c.env.OAUTH_KV);
  if (!refreshToken) {
    return c.json(
      {
        error:
          "No refresh token found. " +
          "Connect a Google account via Settings → Integrations first.",
      },
      404,
    );
  }

  return c.json({ refresh_token: refreshToken });
});

// POST /api/gtm/token — accept a refresh token from the Platform backend
// and store it in KV. Authenticated with X-Internal-Auth.
app.post("/api/gtm/token", async (c) => {
  const authErr = requireApiKey(c);
  if (authErr) return authErr;

  let body: { refresh_token?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.refresh_token || typeof body.refresh_token !== "string") {
    return c.json({ error: "Missing or invalid refresh_token field" }, 400);
  }

  await writeRefreshTokenToKV(c.env.OAUTH_KV, body.refresh_token);

  return c.json({ ok: true });
});

// GET /api/gtm/accounts
app.get("/api/gtm/accounts", async (c) => {
  const authErr = requireApiKey(c);
  if (authErr) return authErr;
  try {
    const service = await getServerTagManagerClient(c.env, getPerUserAccessToken(c));
    const res = await service.accounts.list({});
    return c.json(res.data);
  } catch (e: any) {
    return c.json({ error: e.message || "Internal server error" }, 500);
  }
});

// GET /api/gtm/accounts/:accountId/containers
app.get("/api/gtm/accounts/:accountId/containers", async (c) => {
  const authErr = requireApiKey(c);
  if (authErr) return authErr;
  try {
    const service = await getServerTagManagerClient(c.env, getPerUserAccessToken(c));
    const res = await service.accounts.containers.list({
      parent: `accounts/${c.req.param("accountId")}`,
    });
    return c.json(res.data);
  } catch (e: any) {
    return c.json({ error: e.message || "Internal server error" }, 500);
  }
});

// GET /api/gtm/accounts/:accountId/containers/:containerId/workspaces
app.get("/api/gtm/accounts/:accountId/containers/:containerId/workspaces", async (c) => {
  const authErr = requireApiKey(c);
  if (authErr) return authErr;
  try {
    const service = await getServerTagManagerClient(c.env, getPerUserAccessToken(c));
    const res = await service.accounts.containers.workspaces.list({
      parent: `accounts/${c.req.param("accountId")}/containers/${c.req.param("containerId")}`,
    });
    return c.json(res.data);
  } catch (e: any) {
    return c.json({ error: e.message || "Internal server error" }, 500);
  }
});

// GET /api/gtm/accounts/:accountId/containers/:containerId/workspaces/:workspaceId/tags
app.get("/api/gtm/accounts/:accountId/containers/:containerId/workspaces/:workspaceId/tags", async (c) => {
  const authErr = requireApiKey(c);
  if (authErr) return authErr;
  try {
    const service = await getServerTagManagerClient(c.env, getPerUserAccessToken(c));
    const res = await service.accounts.containers.workspaces.tags.list({
      parent: `accounts/${c.req.param("accountId")}/containers/${c.req.param("containerId")}/workspaces/${c.req.param("workspaceId")}`,
    });
    return c.json(res.data);
  } catch (e: any) {
    return c.json({ error: e.message || "Internal server error" }, 500);
  }
});

// GET /api/gtm/accounts/:accountId/containers/:containerId/workspaces/:workspaceId/triggers
app.get("/api/gtm/accounts/:accountId/containers/:containerId/workspaces/:workspaceId/triggers", async (c) => {
  const authErr = requireApiKey(c);
  if (authErr) return authErr;
  try {
    const service = await getServerTagManagerClient(c.env, getPerUserAccessToken(c));
    const res = await service.accounts.containers.workspaces.triggers.list({
      parent: `accounts/${c.req.param("accountId")}/containers/${c.req.param("containerId")}/workspaces/${c.req.param("workspaceId")}`,
    });
    return c.json(res.data);
  } catch (e: any) {
    return c.json({ error: e.message || "Internal server error" }, 500);
  }
});

// GET /api/gtm/accounts/:accountId/containers/:containerId/workspaces/:workspaceId/variables
app.get("/api/gtm/accounts/:accountId/containers/:containerId/workspaces/:workspaceId/variables", async (c) => {
  const authErr = requireApiKey(c);
  if (authErr) return authErr;
  try {
    const service = await getServerTagManagerClient(c.env, getPerUserAccessToken(c));
    const res = await service.accounts.containers.workspaces.variables.list({
      parent: `accounts/${c.req.param("accountId")}/containers/${c.req.param("containerId")}/workspaces/${c.req.param("workspaceId")}`,
    });
    return c.json(res.data);
  } catch (e: any) {
    return c.json({ error: e.message || "Internal server error" }, 500);
  }
});

// GET /connect — browser-friendly Google OAuth flow to seed the KV refresh token.
// No MCP client required. Just visit /connect in a browser, authorize with Google,
// and the server-level refresh token is stored in KV for Aegis REST API use.
app.get("/connect", async (c) => {
  const state = crypto.randomUUID();
  const scopes = [
    "email",
    "profile",
    "https://www.googleapis.com/auth/tagmanager.manage.accounts",
    "https://www.googleapis.com/auth/tagmanager.edit.containers",
    "https://www.googleapis.com/auth/tagmanager.delete.containers",
    "https://www.googleapis.com/auth/tagmanager.edit.containerversions",
    "https://www.googleapis.com/auth/tagmanager.manage.users",
    "https://www.googleapis.com/auth/tagmanager.publish",
    "https://www.googleapis.com/auth/tagmanager.readonly",
  ];
  const url = getUpstreamAuthorizeUrl({
    upstreamUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    scope: scopes.join(" "),
    clientId: c.env.GOOGLE_CLIENT_ID,
    redirectUri: new URL("/connect/callback", c.req.url).href,
    state,
    hostedDomain: c.env.HOSTED_DOMAIN,
    hasRefreshToken: false,
  });
  return Response.redirect(url);
});

// GET /connect/callback — Google OAuth callback for server-level token seeding.
// Exchanges the code for tokens and writes the refresh token to KV.
// Does NOT create an MCP grant — this is purely for REST API access.
app.get("/connect/callback", async (c) => {
  const code = c.req.query("code");

  if (!code) {
    return c.text("Missing code", 400);
  }

  const [tokenResult, googleErrResponse] = await fetchUpstreamAuthToken({
    upstreamUrl: "https://oauth2.googleapis.com/token",
    clientId: c.env.GOOGLE_CLIENT_ID,
    clientSecret: c.env.GOOGLE_CLIENT_SECRET,
    code,
    redirectUri: new URL("/connect/callback", c.req.url).href,
    grantType: "authorization_code",
  });

  if (googleErrResponse) {
    return googleErrResponse;
  }

  if (tokenResult.refresh_token) {
    await writeRefreshTokenToKV(c.env.OAUTH_KV, tokenResult.refresh_token);
    return new Response(
      "<html><body><h1>✅ GTM Connected</h1><p>The server refresh token has been stored. Aegis can now use the GTM REST API.</p></body></html>",
      { headers: { "Content-Type": "text/html;charset=UTF-8" } },
    );
  }

  return c.text("No refresh token received from Google. Try revoking access at https://myaccount.google.com/permissions and reconnecting.", 400);
});

app.get("/", async () => {
  return new Response(renderMainPage(), {
    headers: {
      "content-type": "text/html;charset=UTF-8",
    },
  });
});

app.get("/privacy", async () => {
  return new Response(renderPrivacyPage(), {
    headers: {
      "content-type": "text/html;charset=UTF-8",
    },
  });
});

app.get("/terms", async () => {
  return new Response(renderTermsPage(), {
    headers: {
      "content-type": "text/html;charset=UTF-8",
    },
  });
});

export { app as apisHandler };
