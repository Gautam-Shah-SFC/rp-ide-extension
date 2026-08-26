# Retroper

An IDE extension for AI usage observability & DLP. It watches the AI surfaces
inside your IDE (in-editor chat panels, and eventually terminal-based coding
agents), captures each prompt/response turn plus basic tool-activity signals
(files read, files edited, permission prompts), and ships that to a backend
for visibility and data-loss-prevention monitoring.

Runs as a standard VS Code extension, which also makes it work in VS Code
forks — Cursor, Antigravity, etc. — since they share the same extension API.

## Status: v1.0

| Provider | Surface | Status |
|---|---|---|
| Cursor | Composer / Agent chat | ✅ implemented, verified against real local data |
| VS Code Chat | Copilot Chat panel | ✅ implemented, verified against a real multi-turn conversation |
| Claude Code | CLI **and** editor tab (same transcript either way) | ✅ implemented, verified against real multi-tool-call sessions - and confirmed IDE-agnostic: `~/.claude/projects` is written by Claude Code itself, not by whichever editor launched it, so one Retroper install captures Claude Code usage from any IDE (or a plain terminal) on that machine |
| Codex CLI | CLI **and** editor tab (same rollout file either way) | ⚠️ implemented, partially verified - file location, session structure, and a real aborted-turn round-trip are confirmed against real Codex CLI 0.149.1 data; a genuinely *completed* assistant response is inferred from OpenAI's public Responses API convention, not confirmed, since testing here had no API key to get past auth. Same IDE-agnostic reasoning as Claude Code applies (`~/.codex/sessions` is Codex's own directory). |
| Antigravity | in-editor chat | ⏳ stub, not installed on the dev machine yet |

A provider now only captures **from the moment it first activates onward** -
on its very first run it silently baselines whatever already exists (marks
it as already-seen without uploading it), so pre-existing history doesn't
get swept in. Verified for all four active providers.

Permission-prompt counting is not yet reliable for any provider — none of the
samples inspected so far had populated tool-call data to confirm the field
shape. Treat `permission_prompts_count` as a placeholder until that's nailed
down against real agent-mode usage.

## How it works

```
[Provider adapter: Cursor / VS Code Chat / ...]
        -> raw turn (poll-based, reads the IDE's own local chat storage)
[normalizerService]
        -> maps to the InteractionRecord shape, computes sha256 hashes/lengths
[bufferService]
        -> appends to a local JSONL queue (survives restarts / offline)
[uploadService]
        -> batches, POSTs { records: [...], source_type: "IDE_Extension" }
           to RETROPER_UPLOAD_URL with a Bearer token from authService
```

Auth: run **Retroper: Login** (email/password), which calls the backend's
`/api/v1/auth/login` and stores the returned JWT in VS Code's `SecretStorage`
(OS-level encrypted credential store - Windows Credential Manager / macOS
Keychain / etc.) - never in a plaintext file. **Retroper: Logout** clears it
(and best-effort calls `/api/v1/auth/logout`). If the token expires (no
refresh token in this API), uploads fail once with a clear "log in again"
message and the extension goes back to "not logged in" until you do.

Nothing is captured from a network API — every adapter reads data the IDE
itself already writes to disk locally (SQLite for Cursor, JSONL event logs
for VS Code's built-in Chat).

## Project structure

Flat by category, no nested subfolders per type:

```
src/
  class/        interfaces & data shapes (InteractionRecord, CaptureEvent, Provider)
  config/       constants.ts (.env-driven), providers.ts (provider registry)
  services/     one file per capture adapter + normalize/buffer/upload/hash/identity
  controllers/  extensionController (activate/deactivate), captureController (event -> buffer -> upload)
  routes/       commandRoutes (VS Code commands), eventRoutes (wires adapters -> captureController)
  utils/        id/path/text/logger/retry helpers
  extension.ts  thin entry point
```

`controllers/` and `routes/` are repurposed for command/event orchestration
rather than HTTP routing, since this is a client-only extension with no
server of its own.

## Setup

See `Installation_Guide.md` (or `Installation_Guide.pdf` to share) in the
project source for full step-by-step instructions - not bundled into the
packaged `.vsix`. Quick
version for local dev:

```bash
npm install
cp .env.example .env      # fill in RETROPER_UPLOAD_URL
```

Then open this folder in VS Code (or Cursor) and press **F5** to launch an
Extension Development Host with Retroper active. On first activation (and
any time you're logged out), it prompts you to log in.

## Commands

- **Retroper: Login** — prompts for email/password, authenticates against the backend, stores the token securely.
- **Retroper: Logout** — clears the stored token.
- **Retroper: Send Test Record** — builds a fake turn, queues it, uploads it immediately. Use this to sanity-check your setup end-to-end.
- **Retroper: Flush Queued Records Now** — uploads whatever is currently queued.
- **Retroper: Show Capture Status** — shows login state, how many records are queued locally, and where the queue file lives.
- **Retroper: Open Audit Log** — opens `audit_log.txt`, a plaintext mirror of every log line (poll heartbeats, captures, logins, uploads, errors - all timestamped), written next to `.env` in the extension's install folder. Useful for diagnosing "why isn't this showing up" without digging through VS Code's per-window Output logs.

A status bar item (bottom right) always shows current login state - click it to log in or out.

## Configuration

Non-secret config lives in `.env` (see `.env.example`):

| Variable | Purpose |
|---|---|
| `RETROPER_UPLOAD_URL` | Backend ingest endpoint |
| `RETROPER_LOGIN_URL` | Optional override; defaults to `<RETROPER_UPLOAD_URL's origin>/api/v1/auth/login` |

`.env` is gitignored and excluded from packaged `.vsix` builds. There is no
JWT in `.env` anymore - auth is handled by the login flow above, and the
token lives only in VS Code's encrypted `SecretStorage`, scoped per machine.

## Known limitations

- Cursor's chat data lives in a WAL-mode SQLite file the IDE itself has open;
  the extension polls it every 20s rather than reacting instantly. It reads
  via `node:sqlite` (compiled into the Node/Electron runtime, so no separate
  native binary to go ABI-stale) when available, which sees WAL data live and
  correctly - the same way Cursor's own reads do. If that runtime lacks
  `node:sqlite`, it falls back to a `sql.js` byte-snapshot of the main file,
  which can miss very recent writes until Cursor's own WAL checkpoint runs;
  check `audit_log.txt` for which mode is active on a given machine.
- Cursor gates capture on `hasBlockingPendingActions` (confirmed against real
  data - false/undefined on 62+ live composers, never a false positive so
  far) so a paused permission/approval prompt isn't mistaken for "finished"
  by settle-detection. VS Code Chat has **no equivalent gate** - an earlier
  attempt at one (guessing at `isConfirmed`/`isComplete` on tool-invocation
  parts) was removed after it turned out to likely false-positive on any
  ordinary, already-completed tool call - which would have permanently
  blocked capture of most agentic turns, since those almost always use a
  tool. So VS Code Chat can still occasionally capture a truncated answer if
  a real permission prompt happens to pause it mid-stream; needs real session
  data with an actual tool-confirmation flow before a safe gate can be added.
- The backend appears to run a synchronous scan/processing step per ingest
  request that scales with payload size - a 62KB response took ~9s to
  return `201`. There's no hard size limit found (tested up to ~2MB), but a
  very long AI response could take tens of seconds to upload, and might hit
  a timeout elsewhere (corporate proxy, VPN, the backend's own server
  timeout) before this extension's own unbounded `fetch` would give up.
  `uploadService.ts` now logs payload size and elapsed time on every
  attempt (success or failure) to `audit_log.txt` for diagnosing this.
- VS Code Chat / Copilot Chat parsing (`vscodeChatService.ts`) is now
  verified against a real multi-turn conversation (2026-08-25). Its JSONL
  log has three patch kinds, not two as first assumed: `kind:0` (full
  snapshot), and `kind:1`/`kind:2` (both `{k, v}` set-at-path patches -
  `kind:2` specifically covers replacing the whole `requests` array when a
  new turn starts, and bulk-setting a request's `response`). The first
  version only applied `kind:1`, so every turn after the first in a given
  chat (which arrives embedded in the initial `kind:0` snapshot) was
  silently invisible - now fixed and confirmed capturing multi-turn chats
  correctly, including the field names (`message.text`, `response[].value`).
  Diagnostic per-turn logging added while chasing this bug is still on
  (verbose - one line per unemitted turn per poll in `audit_log.txt`); safe
  to quiet down once confirmed stable on more real usage.
- No file-read / permission-prompt counts are reliable yet for any provider.
- Identity resolution (`identityService.ts`) is best-effort (VS Code auth
  session, falling back to git config, falling back to OS username) — there
  is no backend-verified account binding yet.
- `authService.ts`'s login response parsing (`extractToken`) is confirmed
  against the real `/api/v1/auth/login` and `/api/v1/auth/logout` endpoints
  existing and erroring correctly on bad credentials, but the *successful*
  response shape is inferred (matched against the sibling rp-mcp-server
  project's same integration) rather than tested with real credentials. If
  login succeeds server-side but the extension reports "no recognizable
  token", check Output > Retroper for the logged raw response body.

## Roadmap

1. ~~Scaffold + upload pipeline, tested with fake records~~ (done)
2. ~~Cursor in-editor chat capture~~ (done)
3. ~~VS Code Chat / Copilot Chat~~ (done, verified against a real multi-turn conversation)
4. ~~Claude Code (CLI + tab) via JSONL transcripts~~ (done, verified)
5. ~~Codex CLI via its rollout JSONL files~~ (done, partially verified - see status table; needs a real completed session to fully confirm the response-side parsing)
6. Antigravity — investigate storage format once installed somewhere
7. Terminal shell-integration fallback capture for anything not covered by structured logs
