import * as path from "path";
import * as dotenv from "dotenv";

// Extension is compiled to dist/config/constants.js; project root (where .env lives)
// is two levels up from there.
dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

/** Ingest endpoint comes from .env (see .env.example). There is no login and no token: identity
 * is a per-device client certificate the extension presents to the mTLS gateway itself - see
 * certIdentityService.ts. */
export const UPLOAD_URL = process.env.RETROPER_UPLOAD_URL ?? "";

/** mTLS gateway identity endpoint. GET returns the certificate the gateway resolved for this
 * device ({ authenticated, subject, issuer, serial, fingerprint, valid_from, valid_until }).
 * Overridable via .env; defaults to the known gateway. */
export const IDENTITY_URL = process.env.RETROPER_IDENTITY_URL?.trim() || "https://ns546939.ip-139-99-120.net:8443/whoami";

/** The gateway's server certificate currently carries only `DNS:retroper-auth.test` in its SAN,
 * so connecting to it by any other hostname fails strict TLS name verification. Until the cert is
 * reissued with the real hostname, the extension still verifies the full chain against the pinned
 * CA but also accepts a server cert whose CN/SAN matches this name. Set to "" (or override) once
 * the gateway cert covers its real hostname. */
export const IDENTITY_TLS_ALLOW_CN = process.env.RETROPER_IDENTITY_ALLOW_CN?.trim() ?? "retroper-auth.test";

/** On Windows, when no client-cert files are present the extension looks in the user's certificate
 * store (Cert:\CurrentUser\My, then LocalMachine\My) for a cert whose issuer or subject contains
 * this string, and exports it (with its private key) for the mTLS handshake. Empty disables the
 * store lookup. */
export const CERT_STORE_ISSUER = process.env.RETROPER_CERT_STORE_ISSUER?.trim() ?? "Retroper Development CA";

/** Device client certificate + CA chain for the mTLS handshake to IDENTITY_URL. All optional and
 * NOT bundled in the .vsix - when unset, certIdentityService falls back to well-known filenames
 * in the shared Retroper data dir (%APPDATA%\Retroper\ on Windows). See certIdentityService.ts. */
export const CLIENT_PFX_PATH = process.env.RETROPER_CLIENT_PFX?.trim() || "";
export const CLIENT_PFX_PASSWORD = process.env.RETROPER_CLIENT_PFX_PASSWORD ?? "";
export const CLIENT_CERT_PATH = process.env.RETROPER_CLIENT_CERT?.trim() || "";
export const CLIENT_KEY_PATH = process.env.RETROPER_CLIENT_KEY?.trim() || "";
export const CA_BUNDLE_PATH = process.env.RETROPER_CA_BUNDLE?.trim() || "";

export const SCHEMA_VERSION = "retroper.ai_interaction.v0.2";
export const SOURCE = "ide_extension";
export const SOURCE_TYPE = "IDE_Extension";
export const EXTENSION_NAME = "retroper";

export const BUFFER_FILE_NAME = "retroper-queue.jsonl";
/** Append-only mirror of every captured record. Unlike the queue file, lines here are NEVER
 * removed after a successful upload - it's the durable local record for an external "endpoint
 * agent" to read and forward (e.g. to an S3 bucket) on its own schedule. One InteractionRecord
 * JSON object per line, same shape as the queue file. */
export const ENDPOINT_FILE_NAME = "retroper-endpoint.jsonl";
export const UPLOAD_BATCH_SIZE = 25;
export const UPLOAD_INTERVAL_MS = 30_000;
export const UPLOAD_MAX_RETRIES = 5;
export const UPLOAD_RETRY_BASE_DELAY_MS = 2_000;

export const CONTENT_STORAGE_BOUNDARY = "customer_local_vpc_poc";
