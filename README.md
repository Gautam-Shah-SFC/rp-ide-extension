# Retroper

Retroper is an IDE extension for AI usage observability and data-loss prevention.
It watches the AI surfaces available inside supported editors — in-editor chat
panels and terminal-based coding agents — captures each prompt/response turn
along with basic tool-activity signals (files read, files edited, tool calls),
and ships that data to the Retroper backend for visibility and DLP monitoring.

It runs as a standard VS Code extension, which means it also works unmodified
in any VS Code-compatible fork — Cursor and Antigravity today — since they
share the same extension API.

## Supported providers

| Provider | Surface | Notes |
|---|---|---|
| Cursor | Composer / Agent chat | Reads Cursor's own local `state.vscdb` |
| VS Code Chat | GitHub Copilot Chat panel | Reads VS Code's own local chat session logs |
| Antigravity | In-editor agent chat | Reads Antigravity's own local conversation transcripts |
| Claude Code | CLI and editor-integrated tab | IDE-agnostic: one install captures usage from any IDE (or a plain terminal) on the machine |
| Codex CLI | CLI and editor-integrated tab | IDE-agnostic, same as Claude Code |

Every provider only reads data the underlying tool already writes to local
disk — nothing is scraped from a network API, and no provider requires any
configuration beyond installing and logging in.

A provider only captures **from the moment it first activates onward**: on
its very first run it silently records whatever conversation history already
exists as "already seen," without uploading any of it, so installing Retroper
never sweeps in a machine's pre-existing chat history.

## How it works

```
[Provider adapter: Cursor / VS Code Chat / Antigravity / Claude Code / Codex]
        -> raw turn (poll-based, reads the tool's own local storage)
[normalizerService]
        -> maps to the InteractionRecord shape, computes sha256 hashes/lengths
[certIdentityService]
        -> GET /whoami on the mTLS gateway; stamps the resolved device
           certificate (fingerprint/serial/subject) onto every record
[bufferService]
        -> appends to a shared local JSONL queue + the durable endpoint log
[uploadService]
        -> (only if RETROPER_UPLOAD_URL is set) batches, POSTs
           { records: [...], source_type: "IDE_Extension" } to the ingest
           endpoint with NO Authorization header - the mTLS gateway
           authenticates by the device client certificate
```

**Shared local queue.** All providers, across every installed IDE host on a
machine, write into one common queue file rather than a separate file per
IDE — see [Local data locations](#local-data-locations) below. This is also
what prevents an IDE-agnostic tool like Claude Code from being captured and
uploaded twice if it's used while two different IDEs are both open.

**Authentication.** There is no login, no password, and no token. Identity is
a per-device client certificate. The extension does a mutual-TLS `GET /whoami`
against the identity gateway **at most once a day**: the resolved identity is
persisted to `retroper-cert-identity.json` in the shared data dir and reused
with no network call until it is ~24h old (so restarting the editor does not
re-hit the gateway). It stamps the certificate it resolves (`fingerprint`,
`serial`, `subject`, `issuer`, `authenticated`, `verified_at`) onto every
captured record as `certificate_identity`, so the endpoint agent tailing
`retroper-endpoint.jsonl` can attribute each turn to a device and forward it
to S3. If the gateway reports no certificate, capture still runs and records
are tagged `authenticated: false` until the next check succeeds. Run
**Retroper: Check Device Certificate** to force an immediate re-check. Wiring
real backend ingest auth is a later DP task.

The client certificate is **not bundled in the `.vsix`** — each machine
supplies its own. The extension looks for it in two places, in order:

1. **Files** in the shared Retroper data dir (or `.env` overrides):

   | File | Purpose |
   |---|---|
   | `client.p12` (+ `client.p12.pass`) | PKCS#12 client cert and its password |
   | `client-cert.pem` + `client-key.pem` | PEM client cert/key (alternative to the `.p12`) |
   | `ca-chain.pem`, or `root_ca.crt` (+ `intermediate_ca.crt`) | CA chain to verify the gateway |

   Overridable via `.env`: `RETROPER_CLIENT_PFX`, `RETROPER_CLIENT_PFX_PASSWORD`,
   `RETROPER_CLIENT_CERT`, `RETROPER_CLIENT_KEY`, `RETROPER_CA_BUNDLE`.

2. **The Windows certificate store** (`Cert:\CurrentUser\My`, then
   `Cert:\LocalMachine\My`) — any cert whose issuer or subject contains
   `Retroper Development CA` (override with `RETROPER_CERT_STORE_ISSUER`).
   Because a store-installed private key is usually non-exportable, the
   `/whoami` call for a store cert goes through Windows' built-in `curl.exe`
   (Schannel), which uses the key in place. If more than one certificate
   matches, the extension asks which one to use and remembers the choice in
   `retroper-cert-selection.json`; with exactly one match it uses that one.

## Local data locations

Every provider on every installed IDE host writes into one shared location,
so a single, predictable path can be handed to anything that needs to read
Retroper's local data directly (support tooling, a separate ingest agent,
etc.) without knowing which IDE(s) produced it.

| OS | Path |
|---|---|
| Windows | `%APPDATA%\Retroper\` |
| macOS | `~/Library/Application Support/Retroper/` |

Files in that folder:

| File | Contents |
|---|---|
| `retroper-endpoint.jsonl` | **Durable, append-only.** Every captured record, one JSON `InteractionRecord` per line, retained permanently — lines are never removed. This is the file an external endpoint agent should read and forward (e.g. to an S3 bucket). Retroper only ever appends here. |
| `retroper-queue.jsonl` | The outgoing send queue for Retroper's own uploader — one record per line, appended as turns are captured and **removed once successfully uploaded**. Only drained when `RETROPER_UPLOAD_URL` is set (direct upload is otherwise off, pending DP); not a reliable record of everything captured (use `retroper-endpoint.jsonl` for that). |
| `retroper-<provider>-state.json` | Per-provider dedup bookkeeping (which turns have already been seen). Not upload content — internal state only. |
| `retroper-cert-identity.json` | The last device certificate resolved from `GET /whoami`, reused for ~24h so the gateway isn't re-hit on every editor start. Delete it (or run **Retroper: Check Device Certificate**) to force a fresh check. |
| `retroper-cert-selection.json` | Which Windows-store certificate the user picked, when more than one matched. Delete it to be asked again. |
| `client.p12` / `client.p12.pass` / `client-cert.pem` / `client-key.pem` / `ca-chain.pem` (or `root_ca.crt` + `intermediate_ca.crt`) | The device's mTLS client certificate and the CA chain used to verify the gateway. **Provisioned per machine — not shipped in the `.vsix`.** |

This folder is created automatically the first time Retroper activates in
any IDE; it is not created by the installer.

## Commands

- **Retroper: Check Device Certificate** — re-runs `GET /whoami` against the mTLS gateway and reports the certificate it resolved (or why it couldn't).
- **Retroper: Send Test Record** — builds a synthetic turn and writes it to the endpoint log (and uploads it if `RETROPER_UPLOAD_URL` is set). Use this to verify an install end-to-end.
- **Retroper: Flush Queued Records Now** — uploads whatever is currently queued (no-op unless `RETROPER_UPLOAD_URL` is set).
- **Retroper: Show Capture Status** — shows the resolved device certificate, how many records are queued locally, and where the queue / endpoint files live.
- **Retroper: Open Audit Log** — opens a plaintext log of every capture, certificate check, and upload event (with timestamps), for diagnosing "why isn't this showing up" without digging through VS Code's per-window Output panel.

A status bar item (bottom right) always shows the current device-certificate
state; click it to re-check.

## Configuration

Non-secret configuration lives in `.env` (all optional):

| Variable | Purpose |
|---|---|
| `RETROPER_UPLOAD_URL` | Direct backend ingest endpoint. **Leave empty** unless DP has provisioned direct upload — with no value, capture still writes `retroper-endpoint.jsonl` for the endpoint agent. When set, uploads carry no `Authorization` header. |
| `RETROPER_IDENTITY_URL` | Override for the mTLS gateway `/whoami` endpoint. Defaults to `https://ns546939.ip-139-99-120.net:8443/whoami`. |

`.env` is gitignored and carries no credentials. The device client
certificate is presented to the gateway outside this extension and is never
stored here.

## Development setup

```bash
npm install
cp .env.example .env      # optional - defaults work for local capture + endpoint log
```

Open this folder in VS Code (or any supported fork) and press **F5** to
launch an Extension Development Host with Retroper active.

### Project structure

```
src/
  class/        interfaces & data shapes (InteractionRecord, CaptureEvent, Provider)
  config/       constants.ts (.env-driven), providers.ts (provider registry)
  services/     one file per capture adapter, plus normalize/buffer/upload/hash/identity/certIdentity
  controllers/  extensionController (activate/deactivate), captureController (event -> buffer -> endpoint log + queue)
  routes/       commandRoutes (VS Code commands), eventRoutes (wires adapters -> captureController)
  utils/        id/path/text/logger/retry/file-lock helpers
  extension.ts  entry point
```

## Known limitations

- **Tool-call detail is still coarse.** `tool_calls_count` is populated for
  every provider; per-tool breakdowns and reliable permission-prompt counting
  are not yet available for any provider.
- **Codex CLI's completion signal is unconfirmed.** Turn boundaries, session
  structure, and cancelled turns are verified against real Codex CLI data,
  but a genuinely *completed* assistant response is inferred from OpenAI's
  public API conventions rather than confirmed end-to-end, and settle
  detection there relies on a defensive text-stability check rather than an
  explicit completion signal.
- **VS Code Chat has no permission-prompt gate.** Unlike Cursor, which has a
  confirmed real signal for "waiting on user approval," VS Code Chat has no
  equivalent — an earlier attempt at one produced false positives on
  ordinary completed tool calls and was removed. A real permission prompt
  can, in rare cases, still be captured as a truncated answer.
- **Identity resolution is best-effort.** It falls back through VS Code's
  auth session, git config, and OS username; there is no backend-verified
  account binding yet.
- **Cursor's chat data is read via polling, not a live event stream** (every
  20 seconds), since it's read directly from Cursor's own on-disk storage
  rather than through an API.

## Roadmap

- [x] Upload pipeline
- [x] Cursor in-editor chat capture
- [x] VS Code Chat / Copilot Chat capture
- [x] Claude Code capture (CLI and editor tab)
- [x] Codex CLI capture (CLI and editor tab)
- [x] Antigravity capture
- [ ] Reliable per-tool activity and permission-prompt counting across all providers
- [ ] Confirmed Codex completion signal
- [ ] Terminal shell-integration fallback capture for tools not covered by structured local logs
