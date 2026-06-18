import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { ouraTokens, type OuraToken } from "../db/schema.js";
import { nowIso } from "../util/time.js";

const AUTHORIZE_URL = "https://cloud.ouraring.com/oauth/authorize";
const TOKEN_URL = "https://api.ouraring.com/oauth/token";
export const OURA_API_BASE = "https://api.ouraring.com/v2";

// Streams we need: daily summaries + raw sleep periods + heart rate.
const SCOPES = "daily heartrate personal";

// Refresh the access token if it expires within this many ms.
const REFRESH_BUFFER_MS = 10 * 60 * 1000;

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
}

/** The single stored token row, or null if Oura is not yet connected. */
export function getTokens(): OuraToken | null {
  return db.select().from(ouraTokens).where(eq(ouraTokens.id, 1)).get() ?? null;
}

export function isConnected(): boolean {
  return getTokens() !== null;
}

/** Build the one-time authorize URL the user opens to grant access. */
export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.OURA_CLIENT_ID,
    redirect_uri: config.OURA_REDIRECT_URI,
    scope: SCOPES,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/** Exchange an authorization code for tokens and persist them (OAuth callback). */
export async function exchangeCode(code: string): Promise<void> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.OURA_REDIRECT_URI,
    client_id: config.OURA_CLIENT_ID,
    client_secret: config.OURA_CLIENT_SECRET,
  });
  const tokens = await requestToken(body);
  persistTokens(tokens);
}

/**
 * Return a valid bearer access token, proactively refreshing (with refresh-token
 * rotation) when it is near expiry so the user only authorizes once.
 */
export async function getValidAccessToken(): Promise<string> {
  const current = getTokens();
  if (!current) {
    throw new Error("Oura is not connected. Run /oura_connect first.");
  }

  const expiresAtMs = Date.parse(current.expiresAt);
  if (Number.isFinite(expiresAtMs) && expiresAtMs - Date.now() > REFRESH_BUFFER_MS) {
    return current.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: current.refreshToken,
    client_id: config.OURA_CLIENT_ID,
    client_secret: config.OURA_CLIENT_SECRET,
  });
  const refreshed = await requestToken(body);
  persistTokens(refreshed);
  return refreshed.access_token;
}

async function requestToken(body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Oura token request failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as TokenResponse;
  if (!json.access_token || !json.refresh_token) {
    throw new Error("Oura token response missing tokens");
  }
  return json;
}

function persistTokens(tokens: TokenResponse): void {
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  const now = nowIso();
  db.insert(ouraTokens)
    .values({
      id: 1,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: ouraTokens.id,
      set: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt,
        updatedAt: now,
      },
    })
    .run();
}
