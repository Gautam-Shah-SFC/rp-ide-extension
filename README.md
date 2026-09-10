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
[bufferService]
        -> appends to a shared local JSONL queue (survives restarts / offline)
[uploadService]
        -> batches, POSTs { records: [...], source_type: "IDE_Extension" }
           to the backend ingest endpoint with a Bearer token from authService
```

**Shared local queue.** All providers, across every installed IDE host on a
machine, write into one common queue file rather than a separate file per
IDE — see [Local data locations](#local-data-locations) below. This is also
what prevents an IDE-agnostic tool like Claude Code from being captured and
uploaded twice if it's used while two different IDEs are both open.

**Authentication.** Run **Retroper: Login** (email/password), which
authenticates against the backend and stores the returned token in the OS's
encrypted credential store (Windows Credential Manager, macOS Keychain, or
equivalent) via VS Code's `SecretStorage` API — never in a plaintext file.
**Retroper: Logout** clears it. If the token expires, uploads fail once with
a clear "log in again" message and the extension returns to a logged-out
state until you do.

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
| `retroper-queue.jsonl` | The outgoing send queue for Retroper's own uploader — one record per line, appended as turns are captured and **removed once successfully uploaded** to the backend. Expected to be near-empty on a healthy install; not a reliable record of everything captured (use `retroper-endpoint.jsonl` for that). |
| `retroper-<provider>-state.json` | Per-provider dedup bookkeeping (which turns have already been seen). Not upload content — internal state only. |

This folder is created automatically the first time Retroper activates in
any IDE; it is not created by the installer.

## Commands

- **Retroper: Login** — authenticates against the backend and stores the token securely.
- **Retroper: Logout** — clears the stored token.
- **Retroper: Send Test Record** — builds a synthetic turn, queues it, and uploads it immediately. Use this to verify an install end-to-end.
- **Retroper: Flush Queued Records Now** — uploads whatever is currently queued.
- **Retroper: Show Capture Status** — shows login state, how many records are queued locally, and where the queue file lives.
- **Retroper: Open Audit Log** — opens a plaintext log of every capture, login, and upload event (with timestamps), for diagnosing "why isn't this showing up" without digging through VS Code's per-window Output panel.

A status bar item (bottom right) always shows current login state; click it
to log in or out.

## Configuration

Non-secret configuration lives in `.env`:

| Variable | Purpose |
|---|---|
| `RETROPER_UPLOAD_URL` | Backend ingest endpoint |
| `RETROPER_LOGIN_URL` | Optional override; defaults to `<RETROPER_UPLOAD_URL's origin>/api/v1/auth/login` |

`.env` is gitignored. It carries no credentials — authentication is handled
entirely by the login flow above, and the resulting token lives only in the
OS's encrypted credential store, scoped per machine.

## Development setup

```bash
npm install
cp .env.example .env      # fill in RETROPER_UPLOAD_URL
```

Open this folder in VS Code (or any supported fork) and press **F5** to
launch an Extension Development Host with Retroper active.

### Project structure

```
src/
  class/        interfaces & data shapes (InteractionRecord, CaptureEvent, Provider)
  config/       constants.ts (.env-driven), providers.ts (provider registry)
  services/     one file per capture adapter, plus normalize/buffer/upload/hash/identity
  controllers/  extensionController (activate/deactivate), captureController (event -> buffer -> upload)
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
