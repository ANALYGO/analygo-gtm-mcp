/* eslint-disable */

declare namespace Cloudflare {
  interface Env {
    OAUTH_KV: KVNamespace;
    GOOGLE_CLIENT_ID: "";
    GOOGLE_CLIENT_SECRET: "";
    COOKIE_ENCRYPTION_KEY: "";
    GTM_API_KEY: "";
    GTM_REFRESH_TOKEN: "";
    HOSTED_DOMAIN: "";
    WORKER_HOST: "";
    MCP_OBJECT: DurableObjectNamespace<import("./src/index").GoogleTagManagerMCPServer>;
  }
}
interface Env extends Cloudflare.Env {}
