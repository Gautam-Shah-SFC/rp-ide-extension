import * as fs from "fs";
import * as tls from "tls";
import * as path from "path";
import { execFile } from "child_process";
import { URL } from "url";
import { CertificateIdentity } from "../class/InteractionRecord";
import {
  IDENTITY_URL,
  IDENTITY_TLS_ALLOW_CN,
  CLIENT_PFX_PATH,
  CLIENT_PFX_PASSWORD,
  CLIENT_CERT_PATH,
  CLIENT_KEY_PATH,
  CA_BUNDLE_PATH,
  CERT_STORE_ISSUER,
} from "../config/constants";
import { sharedRetroperDataDir } from "../utils/pathUtils";
import { logger } from "../utils/logger";

const CHECK_TIMEOUT_MS = 10_000;
/** The resolved identity is persisted to disk and reused without hitting the gateway again until
 * it is older than this. Effectively "check at most once a day" - a fresh editor start inside the
 * window does no network call at all. Force an immediate re-check any time with the
 * "Retroper: Check Device Certificate" command. */
const IDENTITY_TTL_MS = 24 * 60 * 60 * 1000;

/** Status of the last GET /whoami attempt against the mTLS gateway. `no_certificate` means the
 * gateway answered but saw no client cert (HTTP 400); `rejected` means it saw one it would not
 * accept (401/403); `unreachable` covers DNS / TLS-trust / connection failures. */
export type CertCheckStatus = "ok" | "no_certificate" | "rejected" | "unreachable" | "error" | "unknown";

export interface CertIdentity {
  authenticated: boolean;
  subject: string | null;
  issuer: string | null;
  serial: string | null;
  fingerprint: string | null;
  validFrom: string | null;
  validUntil: string | null;
  status: CertCheckStatus;
  detail?: string;
  /** ISO timestamp of the check this identity came from. */
  checkedAt: string;
}

const UNKNOWN_IDENTITY: CertIdentity = {
  authenticated: false,
  subject: null,
  issuer: null,
  serial: null,
  fingerprint: null,
  validFrom: null,
  validUntil: null,
  status: "unknown",
  checkedAt: new Date(0).toISOString(),
};

let cached: CertIdentity = UNKNOWN_IDENTITY;
let loadedFromDisk = false;

function identityStatePath(): string {
  return path.join(sharedRetroperDataDir(), "retroper-cert-identity.json");
}

/** Load the last resolved identity so a normal editor start reuses it instead of re-checking. */
function loadPersisted(): CertIdentity | undefined {
  try {
    const raw = fs.readFileSync(identityStatePath(), "utf8");
    const parsed = JSON.parse(raw) as CertIdentity;
    if (parsed && typeof parsed.status === "string" && typeof parsed.checkedAt === "string") return parsed;
  } catch {
    /* missing or unreadable - treat as no prior check */
  }
  return undefined;
}

function savePersisted(identity: CertIdentity): void {
  try {
    fs.mkdirSync(sharedRetroperDataDir(), { recursive: true });
    fs.writeFileSync(identityStatePath(), JSON.stringify(identity, null, 2));
  } catch (err) {
    logger.warn(`certIdentityService: could not persist identity: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function isFresh(identity: CertIdentity): boolean {
  const age = Date.now() - Date.parse(identity.checkedAt);
  return Number.isFinite(age) && age >= 0 && age < IDENTITY_TTL_MS;
}

export function getCachedIdentity(): CertIdentity {
  if (!loadedFromDisk) {
    const persisted = loadPersisted();
    if (persisted) cached = persisted;
    loadedFromDisk = true;
  }
  return cached;
}

export function isVerified(): boolean {
  return cached.authenticated;
}

/** For normalizerService - the flattened identity stamped onto each captured record, so the
 * endpoint agent tailing retroper-endpoint.jsonl can attribute each turn to a device cert. */
export function certificateIdentityForRecord(): CertificateIdentity {
  return {
    fingerprint: cached.fingerprint,
    serial: cached.serial,
    subject: cached.subject,
    issuer: cached.issuer,
    authenticated: cached.authenticated,
    verified_at: cached.status === "unknown" ? null : cached.checkedAt,
  };
}

// --- device certificate material -------------------------------------------------------------
//
// The client certificate is NOT bundled in the .vsix. Each machine provides its own, so a shared
// build reads whatever is present on that device. Env vars (from an optional extension/.env) win;
// otherwise the shared Retroper data dir (%APPDATA%\Retroper\ on Windows) is the well-known drop
// location, matching where retroper-endpoint.jsonl and the per-provider state files already live.

function firstExistingFile(candidates: (string | undefined)[]): string | undefined {
  for (const c of candidates) {
    if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return undefined;
}

interface ClientCred {
  pfx?: Buffer;
  passphrase?: string;
  key?: Buffer;
  cert?: Buffer;
  source: string;
}

/** One client certificate found in the Windows store. Its private key is usually non-exportable,
 * so we keep the thumbprint + location and let `curl.exe` (Schannel) use the key in place. */
export interface StoreCandidate {
  thumbprint: string;
  subject: string;
  issuer: string;
  notAfter: string;
  storeLocation: "CurrentUser" | "LocalMachine";
}

interface StoreResult {
  candidates: StoreCandidate[];
  /** Retroper CA certs found in the Root/CA trust stores, as PEM buffers. */
  ca: Buffer[];
  detail: string;
}

/** Provided by the extension host (see setCertChooser) - asks the user to pick one certificate
 * when the store holds more than one match. Returns the chosen thumbprint, or undefined if the
 * user dismissed the picker. */
export type CertChooser = (candidates: StoreCandidate[]) => PromiseLike<string | undefined>;

let certChooser: CertChooser | undefined;
export function setCertChooser(fn: CertChooser | undefined): void {
  certChooser = fn;
}

interface CaInfo {
  ca: Buffer[];
  /** A CA file on disk, if one exists - used as curl's --cacert. */
  file?: string;
  source: string;
}

/** File- and env-based client certificate only (Windows-store certs are handled by curlWhoami). */
function loadClientCred(): ClientCred | undefined {
  const dir = sharedRetroperDataDir();

  const pfxPath = firstExistingFile([CLIENT_PFX_PATH, path.join(dir, "client.p12"), path.join(dir, "client.pfx")]);
  if (pfxPath) {
    let passphrase = CLIENT_PFX_PASSWORD || undefined;
    if (!passphrase) {
      const passFile = firstExistingFile([`${pfxPath}.pass`, path.join(dir, "client.p12.pass")]);
      if (passFile) passphrase = fs.readFileSync(passFile, "utf8").trim();
    }
    return { pfx: fs.readFileSync(pfxPath), passphrase, source: `pfx:${pfxPath}` };
  }

  const certPath = firstExistingFile([CLIENT_CERT_PATH, path.join(dir, "client-cert.pem"), path.join(dir, "client.crt")]);
  const keyPath = firstExistingFile([CLIENT_KEY_PATH, path.join(dir, "client-key.pem"), path.join(dir, "client.key")]);
  if (certPath && keyPath) {
    return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath), source: `pem:${certPath}` };
  }

  return undefined;
}

function loadCaBundle(storeCa: Buffer[]): CaInfo | undefined {
  const dir = sharedRetroperDataDir();
  const bundlePath = firstExistingFile([CA_BUNDLE_PATH, path.join(dir, "ca-chain.pem"), path.join(dir, "ca-bundle.pem")]);
  if (bundlePath) return { ca: [fs.readFileSync(bundlePath)], file: bundlePath, source: bundlePath };

  const parts: Buffer[] = [];
  const rootPath = firstExistingFile([path.join(dir, "root_ca.crt"), path.join(dir, "root_ca.pem")]);
  const intPath = firstExistingFile([path.join(dir, "intermediate_ca.crt"), path.join(dir, "intermediate_ca.pem")]);
  if (rootPath) parts.push(fs.readFileSync(rootPath));
  if (intPath) parts.push(fs.readFileSync(intPath));
  if (parts.length) return { ca: parts, file: rootPath ?? intPath, source: [rootPath, intPath].filter(Boolean).join(" + ") };

  if (storeCa.length) return { ca: storeCa, source: `winstore (${storeCa.length} CA cert(s))` };

  return undefined;
}

const selectionStatePath = () => path.join(sharedRetroperDataDir(), "retroper-cert-selection.json");

function loadSelection(): { thumbprint: string } | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(selectionStatePath(), "utf8"));
    if (j && typeof j.thumbprint === "string") return j;
  } catch {
    /* none */
  }
  return undefined;
}

function saveSelection(c: StoreCandidate): void {
  try {
    fs.mkdirSync(sharedRetroperDataDir(), { recursive: true });
    fs.writeFileSync(selectionStatePath(), JSON.stringify({ thumbprint: c.thumbprint, subject: c.subject, chosenAt: new Date().toISOString() }, null, 2));
  } catch (err) {
    logger.warn(`certIdentityService: could not persist certificate selection: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Which store certificate to use:
 *  - 0 candidates -> none
 *  - 1 candidate  -> that one, always
 *  - >1           -> a previously saved choice if it still matches; else ask the user (when a
 *                    chooser is registered and prompting is allowed) and remember the answer;
 *                    else fall back to the one that expires latest, without saving.
 */
async function pickStoreCandidate(candidates: StoreCandidate[], promptOnMultiple: boolean): Promise<StoreCandidate | undefined> {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  const saved = loadSelection();
  const savedMatch = saved && candidates.find((c) => c.thumbprint.toUpperCase() === saved.thumbprint.toUpperCase());
  if (savedMatch && !promptOnMultiple) return savedMatch;

  if (certChooser && (promptOnMultiple || !savedMatch)) {
    try {
      const picked = await certChooser(candidates);
      const pickedMatch = picked && candidates.find((c) => c.thumbprint.toUpperCase() === picked.toUpperCase());
      if (pickedMatch) {
        saveSelection(pickedMatch);
        logger.info(`certIdentityService: user selected certificate "${pickedMatch.subject}" (${pickedMatch.thumbprint})`);
        return pickedMatch;
      }
    } catch (err) {
      logger.warn(`certIdentityService: certificate chooser failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (savedMatch) return savedMatch;

  const newest = [...candidates].sort((a, b) => b.notAfter.localeCompare(a.notAfter))[0];
  logger.warn(
    `certIdentityService: ${candidates.length} matching certificates in the Windows store and no selection - using "${newest.subject}" for now; run "Retroper: Check Device Certificate" to choose`
  );
  return newest;
}

/**
 * Windows only. Enumerates every client certificate in Cert:\CurrentUser\My and
 * Cert:\LocalMachine\My whose issuer or subject contains CERT_STORE_ISSUER, plus any matching CA
 * certs in the Root/CA stores. Does NOT try to export private keys (usually non-exportable) -
 * curlWhoami uses the key in place via Schannel. Best-effort: failures return no candidates.
 */
async function loadWindowsStore(): Promise<StoreResult> {
  if (process.platform !== "win32" || !CERT_STORE_ISSUER) return { candidates: [], ca: [], detail: "n/a" };

  const needle = CERT_STORE_ISSUER.replace(/'/g, "''");
  const ps = `
$ErrorActionPreference = 'Stop'
$needle = '${needle}'
$out = @()
foreach ($loc in 'CurrentUser','LocalMachine') {
  Get-ChildItem "Cert:\\$loc\\My" -ErrorAction SilentlyContinue |
    Where-Object { $_.HasPrivateKey -and ($_.Issuer -like "*$needle*" -or $_.Subject -like "*$needle*") } |
    ForEach-Object {
      $out += [pscustomobject]@{
        thumbprint = $_.Thumbprint; subject = $_.Subject; issuer = $_.Issuer
        notAfter = $_.NotAfter.ToString('yyyy-MM-dd'); storeLocation = $loc
      }
    }
}
$cas = @()
foreach ($s in 'Cert:\\CurrentUser\\Root','Cert:\\LocalMachine\\Root','Cert:\\CurrentUser\\CA','Cert:\\LocalMachine\\CA') {
  Get-ChildItem $s -ErrorAction SilentlyContinue | Where-Object { $_.Subject -like "*$needle*" } | ForEach-Object {
    $b64 = [Convert]::ToBase64String($_.RawData)
    $pem = "-----BEGIN CERTIFICATE-----\`n"
    for ($i = 0; $i -lt $b64.Length; $i += 64) { $pem += $b64.Substring($i, [Math]::Min(64, $b64.Length - $i)) + "\`n" }
    $pem += "-----END CERTIFICATE-----"
    $cas += $pem
  }
}
[pscustomobject]@{ candidates = @($out); cas = @($cas | Select-Object -Unique) } | ConvertTo-Json -Compress -Depth 4
`.trim();

  let stdout: string;
  try {
    stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
        { timeout: 20_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (err, out, errOut) => (err ? reject(new Error(`${err.message}${errOut ? " | " + errOut : ""}`)) : resolve(out))
      );
    });
  } catch (err) {
    logger.warn(`certIdentityService: Windows cert store lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    return { candidates: [], ca: [], detail: "store lookup failed" };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(stdout.trim() || "{}");
  } catch {
    return { candidates: [], ca: [], detail: "store lookup returned no parseable result" };
  }

  const rawCands = Array.isArray(parsed?.candidates) ? parsed.candidates : parsed?.candidates ? [parsed.candidates] : [];
  const candidates: StoreCandidate[] = rawCands
    .filter((c: any) => c && typeof c.thumbprint === "string")
    .map((c: any) => ({
      thumbprint: String(c.thumbprint),
      subject: String(c.subject ?? ""),
      issuer: String(c.issuer ?? ""),
      notAfter: String(c.notAfter ?? ""),
      storeLocation: c.storeLocation === "LocalMachine" ? "LocalMachine" : "CurrentUser",
    }));
  const rawCas = Array.isArray(parsed?.cas) ? parsed.cas : parsed?.cas ? [parsed.cas] : [];
  const ca: Buffer[] = rawCas.filter((s: unknown): s is string => typeof s === "string").map((s: string) => Buffer.from(s, "utf8"));

  return { candidates, ca, detail: `${candidates.length} store cert(s), ${ca.length} store CA cert(s)` };
}

/**
 * mTLS GET /whoami using a Windows-store certificate via `curl.exe` (Schannel), which can use a
 * non-exportable private key in place. Handles the current hostname mismatch with --connect-to.
 */
function curlWhoami(target: URL, cand: StoreCandidate, caFile: string | undefined): Promise<MtlsOutcome> {
  const sysCurl = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "curl.exe");
  const exe = fs.existsSync(sysCurl) ? sysCurl : "curl";
  const port = target.port || "443";
  const useAlias = !!IDENTITY_TLS_ALLOW_CN && IDENTITY_TLS_ALLOW_CN !== target.hostname;
  const url = useAlias ? `${target.protocol}//${IDENTITY_TLS_ALLOW_CN}:${port}${target.pathname}${target.search}` : IDENTITY_URL;

  const args = [
    "-sS",
    "--ssl-no-revoke",
    "-m",
    String(Math.ceil(CHECK_TIMEOUT_MS / 1000)),
    "-w",
    "\n%{http_code}",
    "--cert",
    `${cand.storeLocation}\\MY\\${cand.thumbprint}`,
  ];
  if (caFile) args.push("--cacert", caFile);
  if (useAlias) args.push("--connect-to", `${IDENTITY_TLS_ALLOW_CN}:${port}:${target.hostname}:${port}`);
  args.push(url);

  return new Promise((resolve) => {
    execFile(exe, args, { timeout: CHECK_TIMEOUT_MS + 5000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const out = (stdout || "").replace(/\r/g, "");
      const nl = out.lastIndexOf("\n");
      const codeStr = (nl >= 0 ? out.slice(nl + 1) : out).trim();
      const body = nl >= 0 ? out.slice(0, nl) : "";
      const status = /^\d{3}$/.test(codeStr) ? Number(codeStr) : 0;
      if (status === 0) {
        const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
        resolve({
          kind: "error",
          code: `CURL_${e?.code ?? "ERR"}`,
          message: (stderr || out || (err && err.message) || "curl produced no output").trim().slice(0, 300),
        });
        return;
      }
      resolve({ kind: "response", status, body });
    });
  });
}

// --- the check -------------------------------------------------------------------------------

/**
 * Resolves the device identity once. If a previous result is on disk and younger than
 * IDENTITY_TTL_MS (~1 day), it is reused with NO network call - so restarting the editor does not
 * re-hit the gateway. Otherwise it does one mutual-TLS GET /whoami (raw tls.connect, presenting
 * the device's client certificate and verifying the gateway against the local CA chain) and
 * persists the result. There is no recurring timer; "Retroper: Check Device Certificate" forces
 * an immediate re-check.
 */
export async function start(): Promise<CertIdentity> {
  const persisted = loadPersisted();
  loadedFromDisk = true;
  if (persisted && isFresh(persisted)) {
    cached = persisted;
    logger.info(
      `certIdentityService: reusing identity from ${persisted.checkedAt} (${describe(persisted)}) - no gateway call (next check after ${new Date(Date.parse(persisted.checkedAt) + IDENTITY_TTL_MS).toISOString()})`
    );
    return cached;
  }
  return refreshIdentity({ promptOnMultiple: false });
}

/** No-op: kept for the deactivate() call site. Nothing recurring runs any more. */
export function stop(): void {
  /* nothing to tear down */
}

type MtlsOutcome =
  | { kind: "response"; status: number; body: string }
  | { kind: "error"; code: string; message: string };

/**
 * Does the mutual-TLS GET with raw `tls.connect` and a hand-written HTTP/1.1 request, deliberately
 * NOT `https.request`. VS Code / Cursor monkey-patch `https` and `tls.createSecureContext` at
 * startup (to inject OS/corporate root certificates); that patch keeps the `ca` option but drops
 * an extension's `pfx`/`cert`/`key`, so a client certificate sent through `https.request` from an
 * extension never reaches the server - the gateway then answers 400 "no client certificate". A
 * plain `tls.connect` with an explicit `secureContext` we build ourselves bypasses that.
 */
function mtlsGet(target: URL, cred: ClientCred | undefined, ca: Buffer[] | undefined, _checkedAt: string): Promise<MtlsOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (o: MtlsOutcome) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(o);
    };

    let secureContext: tls.SecureContext;
    try {
      secureContext = tls.createSecureContext({
        ca,
        pfx: cred?.pfx,
        passphrase: cred?.passphrase,
        key: cred?.key,
        cert: cred?.cert,
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      resolve({ kind: "error", code: e.code ?? "SECURE_CONTEXT_FAILED", message: `could not load client certificate: ${e.message}` });
      return;
    }

    const port = Number(target.port) || 443;
    const socket = tls.connect({
      host: target.hostname,
      port,
      servername: target.hostname,
      secureContext,
      // Also pass the material directly, not only via secureContext, so whichever path the
      // runtime honours gets it. Verify the gateway against our CA chain.
      ca,
      pfx: cred?.pfx,
      passphrase: cred?.passphrase,
      key: cred?.key,
      cert: cred?.cert,
      rejectUnauthorized: true,
      // The chain is still fully verified against the pinned CA (rejectUnauthorized stays true).
      // This only relaxes the hostname check: the gateway cert currently names retroper-auth.test
      // only, so connecting by its real hostname would otherwise fail ERR_TLS_CERT_ALTNAME_INVALID.
      checkServerIdentity: (hostname, cert) => {
        const err = tls.checkServerIdentity(hostname, cert);
        if (!err || !IDENTITY_TLS_ALLOW_CN) return err;
        const cn = (cert.subject && (cert.subject as any).CN) || "";
        const san = cert.subjectaltname || "";
        if (cn === IDENTITY_TLS_ALLOW_CN || san.split(/,\s*/).includes(`DNS:${IDENTITY_TLS_ALLOW_CN}`)) {
          logger.warn(
            `certIdentityService: gateway cert names ${cn || san} (not ${hostname}) - accepting: chain verified against pinned CA, name allow-listed via RETROPER_IDENTITY_ALLOW_CN`
          );
          return undefined;
        }
        return err;
      },
    });

    socket.setTimeout(CHECK_TIMEOUT_MS, () => done({ kind: "error", code: "ETIMEDOUT", message: `no response within ${CHECK_TIMEOUT_MS}ms` }));

    socket.once("secureConnect", () => {
      logger.info(
        `certIdentityService: TLS up (authorized=${socket.authorized}${socket.authorizationError ? ", authorizationError=" + socket.authorizationError : ""}, protocol=${socket.getProtocol()}, clientCertSent=${!!socket.getCertificate() && Object.keys(socket.getCertificate() as object).length > 0})`
      );
      const reqPath = (target.pathname || "/") + (target.search || "");
      socket.write(
        `GET ${reqPath} HTTP/1.1\r\n` +
          `Host: ${target.host}\r\n` +
          `User-Agent: retroper-ide-extension\r\n` +
          `Accept: application/json\r\n` +
          `Connection: close\r\n\r\n`
      );
    });

    const chunks: Buffer[] = [];
    socket.on("data", (d: Buffer) => chunks.push(d));
    socket.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const sep = raw.indexOf("\r\n\r\n");
      if (sep === -1) {
        done({ kind: "error", code: "BAD_RESPONSE", message: "no HTTP header terminator in response" });
        return;
      }
      const head = raw.slice(0, sep);
      let body = raw.slice(sep + 4);
      const statusMatch = head.match(/^HTTP\/\d\.\d (\d{3})/);
      const status = statusMatch ? Number(statusMatch[1]) : 0;
      if (/^transfer-encoding:\s*chunked/im.test(head)) {
        body = dechunk(body);
      }
      done({ kind: "response", status, body });
    });
    socket.on("error", (err: NodeJS.ErrnoException) => {
      done({ kind: "error", code: err.code ?? err.name ?? "TLS_ERROR", message: err.message });
    });
  });
}

/** Minimal HTTP/1.1 chunked-transfer decoder for the small /whoami JSON body. */
function dechunk(body: string): string {
  let out = "";
  let i = 0;
  while (i < body.length) {
    const nl = body.indexOf("\r\n", i);
    if (nl === -1) break;
    const size = parseInt(body.slice(i, nl).trim(), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    out += body.slice(nl + 2, nl + 2 + size);
    i = nl + 2 + size + 2;
  }
  return out || body;
}

/** Force one mTLS GET /whoami now and persist the result (so it is reused for ~a day). Never
 * throws - every failure mode is folded into the returned identity's `status`/`detail`.
 * `promptOnMultiple` (default true) lets the user pick when the Windows store holds >1 match. */
export async function refreshIdentity(opts?: { promptOnMultiple?: boolean }): Promise<CertIdentity> {
  loadedFromDisk = true;
  const result = await doRefreshIdentity(opts?.promptOnMultiple ?? true);
  savePersisted(result);
  return result;
}

async function doRefreshIdentity(promptOnMultiple: boolean): Promise<CertIdentity> {
  const checkedAt = new Date().toISOString();

  if (!IDENTITY_URL) {
    cached = { ...UNKNOWN_IDENTITY, status: "error", detail: "RETROPER_IDENTITY_URL is not set", checkedAt };
    return cached;
  }

  let target: URL;
  try {
    target = new URL(IDENTITY_URL);
  } catch {
    cached = { ...UNKNOWN_IDENTITY, status: "error", detail: `RETROPER_IDENTITY_URL is not a valid URL: ${IDENTITY_URL}`, checkedAt };
    return cached;
  }

  let fileCred: ClientCred | undefined;
  let caInfo: CaInfo | undefined;
  let store: StoreResult = { candidates: [], ca: [], detail: "n/a" };
  let chosen: StoreCandidate | undefined;
  try {
    // Files in %APPDATA%\Retroper\ (and env vars) win. Otherwise fall back to a client certificate
    // installed in the Windows store - so a shared build works on a device where only the user
    // certificate has been provisioned.
    fileCred = loadClientCred();
    if (!fileCred) {
      store = await loadWindowsStore();
      chosen = await pickStoreCandidate(store.candidates, promptOnMultiple);
    }
    caInfo = loadCaBundle(store.ca);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(`certIdentityService: failed to read device certificate material: ${detail}`);
    cached = { ...UNKNOWN_IDENTITY, status: "error", detail: `could not read device certificate files: ${detail}`, checkedAt };
    return cached;
  }

  const credDesc = fileCred
    ? fileCred.source
    : chosen
      ? `winstore:${chosen.subject} [${chosen.storeLocation}\\MY\\${chosen.thumbprint.slice(0, 12)}…]`
      : `NONE FOUND (no files in ${sharedRetroperDataDir()} and no matching cert in the Windows store)`;
  logger.info(`certIdentityService: checking ${IDENTITY_URL} - client cert: ${credDesc}; CA: ${caInfo?.source ?? "system trust only"}`);

  const outcome =
    fileCred || !chosen
      ? await mtlsGet(target, fileCred, caInfo?.ca, checkedAt)
      : await curlWhoami(target, chosen, caInfo?.file);

  if (outcome.kind === "error") {
    // TLS-trust failure (UNABLE_TO_GET_ISSUER_CERT_LOCALLY / SELF_SIGNED_CERT_IN_CHAIN), DNS,
    // connection refused, timeout, or a client key that could not be loaded.
    const hint =
      outcome.code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" || outcome.code === "SELF_SIGNED_CERT_IN_CHAIN"
        ? ` - drop root_ca.crt (and intermediate_ca.crt) into ${sharedRetroperDataDir()}`
        : "";
    const detail = `${outcome.code}: ${outcome.message}${hint}`;
    logger.warn(`certIdentityService: /whoami unreachable - ${detail}`);
    cached = { ...UNKNOWN_IDENTITY, status: "unreachable", detail, checkedAt };
    return cached;
  }

  let body: any = null;
  try {
    body = outcome.body ? JSON.parse(outcome.body) : null;
  } catch {
    // non-JSON body handled below
  }

  if (outcome.status < 200 || outcome.status >= 300) {
    // Mirrors the browser extension's mapping: 400 = gateway got no client certificate at all;
    // 401/403 = it got one it will not accept.
    const status: CertCheckStatus =
      outcome.status === 400 ? "no_certificate" : outcome.status === 401 || outcome.status === 403 ? "rejected" : "error";
    const detail = `HTTP ${outcome.status} ${outcome.body.slice(0, 200).replace(/\s+/g, " ")}`.trim();
    logger.warn(`certIdentityService: /whoami returned ${status} - ${detail}`);
    cached = { ...UNKNOWN_IDENTITY, status, detail, checkedAt };
    return cached;
  }

  const authenticated = body?.authenticated === true;
  cached = {
    authenticated,
    subject: body?.subject ?? null,
    issuer: body?.issuer ?? null,
    serial: body?.serial ?? null,
    fingerprint: body?.fingerprint ?? null,
    validFrom: body?.valid_from ?? null,
    validUntil: body?.valid_until ?? null,
    status: authenticated ? "ok" : "no_certificate",
    detail: authenticated ? undefined : "gateway responded but did not report an authenticated certificate",
    checkedAt,
  };

  if (authenticated) {
    logger.info(
      `certIdentityService: gateway verified device certificate ${cached.fingerprint} (${cached.subject}), valid until ${cached.validUntil}`
    );
  } else {
    logger.warn(`certIdentityService: /whoami reachable but not authenticated: ${outcome.body.slice(0, 200)}`);
  }
  return cached;
}

/** One-line summary for the status bar / status command. */
export function describe(identity: CertIdentity = cached): string {
  switch (identity.status) {
    case "ok":
      return `certificate ${identity.subject ?? identity.fingerprint ?? "verified"}`;
    case "no_certificate":
      return "no device certificate presented to the gateway";
    case "rejected":
      return "device certificate rejected by the gateway";
    case "unreachable":
      return "identity gateway unreachable";
    case "unknown":
      return "certificate not checked yet";
    default:
      return `certificate check error${identity.detail ? ` (${identity.detail})` : ""}`;
  }
}
