import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { config } from "./config.js";
import { exchangeCode } from "./oura/client.js";

/**
 * Minimal HTTP server hosting the one-time Oura OAuth callback.
 * Returns the running server so it can be closed on graceful shutdown.
 */
export function startHttpServer(): ServerType {
  const app = new Hono();

  app.get("/", (c) => c.text("LifeLog is running."));

  app.get("/oura/callback", async (c) => {
    const code = c.req.query("code");
    const error = c.req.query("error");

    if (error) {
      return c.html(`<h2>Oura authorization failed</h2><p>${escapeHtml(error)}</p>`, 400);
    }
    if (!code) {
      return c.html(`<h2>Missing authorization code</h2>`, 400);
    }

    try {
      await exchangeCode(code);
      return c.html(
        `<h2>✅ Oura connected</h2><p>You can close this tab. Nightly pulls are now active; send /sync in Telegram to pull immediately.</p>`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.html(`<h2>Token exchange failed</h2><pre>${escapeHtml(msg)}</pre>`, 500);
    }
  });

  const server = serve({ fetch: app.fetch, port: config.OAUTH_HTTP_PORT });
  console.log(`[http] OAuth callback server listening on :${config.OAUTH_HTTP_PORT}`);
  return server;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
