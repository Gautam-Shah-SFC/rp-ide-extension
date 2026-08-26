import * as path from "path";
import * as dotenv from "dotenv";

// Extension is compiled to dist/config/constants.js; project root (where .env lives)
// is two levels up from there.
dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

/** Ingest endpoint comes from .env (see .env.example). Auth is no longer a static token here -
 * see authService.ts, which logs the user in via email/password and stores the resulting JWT
 * in VS Code SecretStorage (OS-level encrypted credential store), not a plaintext file. */
export const UPLOAD_URL = process.env.RETROPER_UPLOAD_URL ?? "";

/** Same host as UPLOAD_URL, used for /api/v1/auth/* (login/logout/me). */
export const API_BASE_URL = UPLOAD_URL ? new URL(UPLOAD_URL).origin : "";

/** Optional override, matching the sibling rp-mcp-server project's convention. Defaults to
 * API_BASE_URL + /api/v1/auth/login, which is the confirmed real endpoint. */
export const LOGIN_URL = process.env.RETROPER_LOGIN_URL?.trim() || (API_BASE_URL ? `${API_BASE_URL}/api/v1/auth/login` : "");

export const SCHEMA_VERSION = "retroper.ai_interaction.v0.2";
export const SOURCE = "ide_extension";
export const SOURCE_TYPE = "IDE_Extension";
export const EXTENSION_NAME = "retroper";

export const BUFFER_FILE_NAME = "retroper-queue.jsonl";
export const UPLOAD_BATCH_SIZE = 25;
export const UPLOAD_INTERVAL_MS = 30_000;
export const UPLOAD_MAX_RETRIES = 5;
export const UPLOAD_RETRY_BASE_DELAY_MS = 2_000;

export const CONTENT_STORAGE_BOUNDARY = "customer_local_vpc_poc";
