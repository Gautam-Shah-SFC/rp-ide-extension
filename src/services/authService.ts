import * as vscode from "vscode";
import { API_BASE_URL, LOGIN_URL } from "../config/constants";
import { logger } from "../utils/logger";

const TOKEN_KEY = "retroperJwt";
const EXPIRES_AT_KEY = "retroperJwtExpiresAt";
const LOGIN_TIMEOUT_MS = 10_000;

export interface RetroperUser {
  email: string;
  name?: string;
  role?: string;
}

let secrets: vscode.SecretStorage | undefined;
let cachedUser: RetroperUser | undefined;

export function initialize(context: vscode.ExtensionContext): void {
  secrets = context.secrets;
}

/** Returns the stored token, or undefined if there isn't one or it has expired
 * (matches rp-mcp-server's authStore.isTokenValid - expiresAt null means "no known expiry"). */
export async function getToken(): Promise<string | undefined> {
  if (!secrets) return undefined;
  const token = await secrets.get(TOKEN_KEY);
  if (!token) return undefined;

  const expiresAtRaw = await secrets.get(EXPIRES_AT_KEY);
  const expiresAt = expiresAtRaw ? Number(expiresAtRaw) : null;
  if (expiresAt !== null && Date.now() >= expiresAt) {
    logger.info("authService: stored token has expired, treating as logged out");
    await clearStoredToken();
    return undefined;
  }
  return token;
}

export async function isLoggedIn(): Promise<boolean> {
  return !!(await getToken());
}

export function getCachedUser(): RetroperUser | undefined {
  return cachedUser;
}

export async function login(email: string, password: string): Promise<RetroperUser> {
  if (!secrets) {
    throw new Error("authService not initialized");
  }
  if (!LOGIN_URL) {
    throw new Error("RETROPER_UPLOAD_URL (or RETROPER_LOGIN_URL) is not set in .env, so the login server can't be determined.");
  }

  const parsed = await postJson(LOGIN_URL, { email, password });

  const token = extractToken(parsed);
  if (!token) {
    logger.error(`authService: login succeeded but no token found in response body: ${JSON.stringify(parsed)}`);
    throw new Error(
      "Login succeeded but the response didn't contain a recognizable token - see Output > Retroper for the raw response."
    );
  }

  // Prefer the server-stated expires_in (seconds from now) over decoding the JWT ourselves -
  // it's the documented contract; JWT decoding is a fallback for a token shape that omits it.
  const expiresIn = typeof parsed?.expires_in === "number" ? parsed.expires_in : null;
  const expiresAt = expiresIn !== null ? Date.now() + expiresIn * 1000 : decodeJwtExpiry(token);

  await secrets.store(TOKEN_KEY, token);
  await secrets.store(EXPIRES_AT_KEY, expiresAt === null ? "" : String(expiresAt));

  cachedUser = {
    email: parsed?.user?.email || email,
    name: parsed?.user?.name || undefined,
    role: parsed?.user?.role || undefined,
  };
  return cachedUser;
}

export async function logout(): Promise<void> {
  if (!secrets) {
    throw new Error("authService not initialized");
  }
  const token = await secrets.get(TOKEN_KEY);
  if (token && API_BASE_URL) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), LOGIN_TIMEOUT_MS);
      try {
        await fetch(`${API_BASE_URL}/api/v1/auth/logout`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      logger.warn(`authService: server-side logout call failed, clearing local token anyway: ${String(err)}`);
    }
  }
  await clearStoredToken();
}

/** Drops the local token without calling the server - used after a 401 on upload, where the
 * token is already known-invalid server-side. */
export async function clearStoredToken(): Promise<void> {
  await secrets?.delete(TOKEN_KEY);
  await secrets?.delete(EXPIRES_AT_KEY);
  cachedUser = undefined;
}

async function postJson(url: string, body: unknown): Promise<any> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LOGIN_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeoutId);
  }

  const rawBody = await response.text();
  let parsed: any = null;
  try {
    parsed = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    // non-JSON body, handled below
  }

  if (!response.ok) {
    const detail = parsed?.error?.message ?? parsed?.error ?? parsed?.message ?? rawBody.slice(0, 200) ?? response.statusText;
    throw new Error(typeof detail === "string" ? detail : `Login failed (HTTP ${response.status})`);
  }

  return parsed;
}

/** Login response shape matches rp-mcp-server's retroperAuth.ts (same backend). */
function extractToken(body: any): string | undefined {
  const candidate = body?.token ?? body?.access_token ?? body?.jwt ?? body?.data?.token ?? body?.data?.access_token;
  return typeof candidate === "string" && candidate.split(".").length === 3 ? candidate : undefined;
}

/** Decodes the `exp` claim (seconds) out of a JWT payload, without verifying the signature. */
function decodeJwtExpiry(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payloadJson = Buffer.from(payloadB64, "base64").toString("utf8");
    const payload = JSON.parse(payloadJson);
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}
