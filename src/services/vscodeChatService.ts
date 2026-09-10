import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Provider, CaptureEventHandler } from "../class/Provider";
import { CaptureEvent } from "../class/CaptureEvent";
import { logger } from "../utils/logger";
import { loadKeySet, saveKeySet } from "./stateService";
import { SettleTracker } from "./settleTracker";
import { tryAcquireLock, releaseLock } from "../utils/fileLock";

const POLL_INTERVAL_MS = 20_000;

type KeyPath = (string | number)[];

interface LogLine {
  kind: 0 | 1 | 2;
  v: unknown;
  k?: KeyPath;
}

/**
 * VS Code's built-in Chat view (which hosts Copilot Chat as a "responder") persists each session
 * as an append-only JSONL event log: one "kind":0 full snapshot line followed by "kind":1/"kind":2
 * incremental patch lines ({k: keyPath, v: newValue}).
 *
 * CONFIRMED via a real multi-turn trace on 2026-09-01: every time a new question is submitted in
 * an existing chat tab, VS Code does NOT append to `requests[]` - it replaces the entire array
 * with a fresh one-element array holding just the new question (a "kind":2 patch whose keyPath is
 * exactly ["requests"]). The outgoing turn's `message` field is discarded from the array structure
 * at that instant; a few late patches then re-attach that turn's completion stats (timing, token
 * counts) at a new, higher array index, but never re-send its `message`. Reading only the FINAL
 * reconstructed state (as this used to) means every turn except the most recent, not-yet-
 * superseded one loses its prompt permanently the moment a follow-up question is asked - the
 * turn just sits forever un-capturable, which looked like "response stops getting logged partway
 * through" from the outside. Fixed by archiving each turn's state the moment it's about to be
 * superseded (see processSessionFile), not just reading the end state. Turns are keyed by their
 * own stable `requestId` (present on every element with a `message`) rather than array position,
 * since array position is no longer a meaningful identity once resets can happen mid-conversation.
 */
export class VscodeChatProvider implements Provider {
  readonly id = "vscode_chat";
  readonly displayName = "VS Code Chat";

  private timer: NodeJS.Timeout | undefined;
  private emittedTurnKeys: Set<string> = new Set();
  private sessionDirs: string[] = [];
  private statePath: string;
  private lockPath: string;
  private settleTracker = new SettleTracker();

  constructor(private readonly context: vscode.ExtensionContext) {
    const globalStorageParent = path.dirname(context.globalStorageUri.fsPath);
    this.sessionDirs.push(path.join(globalStorageParent, "emptyWindowChatSessions"));

    if (context.storageUri) {
      const workspaceStorageDir = path.dirname(context.storageUri.fsPath);
      this.sessionDirs.push(path.join(workspaceStorageDir, "chatSessions"));
    }

    this.statePath = path.join(context.globalStorageUri.fsPath, "retroper-vscode-chat-state.json");
    this.lockPath = `${this.statePath}.lock`;
  }

  async isAvailable(): Promise<boolean> {
    return this.sessionDirs.some((dir) => fs.existsSync(dir));
  }

  async start(onEvent: CaptureEventHandler): Promise<void> {
    if (!(await this.isAvailable())) {
      logger.info("VscodeChatProvider: no chat session directories found, skipping");
      return;
    }
    const poll = () => {
      try {
        this.pollOnce(onEvent);
      } catch (err) {
        logger.error("VscodeChatProvider: poll failed", err);
      }
    };
    poll();
    this.timer = setInterval(poll, POLL_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private pollOnce(onEvent: CaptureEventHandler): void {
    // See CursorChatProvider for why: the dedup-state file (and the global
    // emptyWindowChatSessions folder) is shared across every IDE window running this
    // extension, so a lock + fresh reload per poll is needed to avoid duplicate captures.
    const token = tryAcquireLock(this.lockPath);
    if (!token) {
      logger.info("VscodeChatProvider: another window is polling this cycle, skipping");
      return;
    }
    try {
      this.pollOnceLocked(onEvent);
    } finally {
      releaseLock(this.lockPath, token);
    }
  }

  private pollOnceLocked(onEvent: CaptureEventHandler): void {
    // First time this provider has ever run: capture only from now on, not this machine's
    // entire pre-existing chat history. Everything found on this one pass gets silently marked
    // as already-seen (same code path, just a no-op onEvent) so later turns in the same
    // sessions are still correctly recognized as new.
    const isFirstRun = !fs.existsSync(this.statePath);
    const effectiveOnEvent: CaptureEventHandler = isFirstRun ? () => {} : onEvent;

    this.emittedTurnKeys = loadKeySet(this.statePath);
    const sizeBefore = this.emittedTurnKeys.size;
    let filesScanned = 0;
    for (const dir of this.sessionDirs) {
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith(".jsonl")) continue;
        filesScanned++;
        this.processSessionFile(path.join(dir, file), effectiveOnEvent);
      }
    }
    const changedThisPoll = this.emittedTurnKeys.size - sizeBefore;
    if (isFirstRun) {
      logger.info(`VscodeChatProvider: first run - baselining ${changedThisPoll} pre-existing turn(s) as already-seen, will not be uploaded. Only new activity from here on will be captured.`);
    } else {
      logger.info(`VscodeChatProvider: poll tick - ${filesScanned} session file(s) scanned, ${changedThisPoll} new turn(s) emitted`);
    }
    if (changedThisPoll > 0 || isFirstRun) {
      saveKeySet(this.statePath, this.emittedTurnKeys);
    }
  }

  private processSessionFile(filePath: string, onEvent: CaptureEventHandler): void {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return;

    let topState: any = {}; // everything in the snapshot/patches except `requests[]` itself
    let currentTurn: any | undefined; // the turn most recently introduced (by the snapshot or a reset)
    let activeIndex: number | undefined; // the numeric index THIS turn's own patches use - learned, not assumed
    const archivedTurns: any[] = []; // final output order, chronological
    const turnByIndex = new Map<number, any>(); // every numeric index ever learned, persists all file

    // CONFIRMED via two real conversations that the numeric index a turn's own progress patches
    // use is NOT reliably 0 - one real session used index 0 for the active turn throughout
    // (2026-09-01), another real session (2026-09-07) used index 0 for the first turn but index 1
    // for the second, with index 0 never touched again. Assuming "0 = active" silently merged the
    // second turn's real completion data (including its own elapsedMs and true final response)
    // into the FIRST turn's object instead - the second turn was then judged done purely by its
    // text going quiet during tool calls, which is exactly the premature-capture bug reported
    // 2026-09-07 (captured mid-sentence, still 8 of 12 real steps away from the actual answer).
    // Fixed by not assuming an index at all: each time a turn is introduced, its index is UNKNOWN
    // until the first patch after it arrives - whatever numeric index that patch uses IS this
    // turn's index, learned once and reused for the rest of its patches.
    const demote = () => {
      if (currentTurn?.message) archivedTurns.push(currentTurn);
    };

    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let entry: LogLine;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.kind === 0) {
        const snapshot: any = entry.v ?? {};
        const { requests, ...rest } = snapshot;
        topState = rest;
        const initial: any[] = Array.isArray(requests) ? requests : [];
        currentTurn = initial.length > 0 ? initial[initial.length - 1] : undefined;
        activeIndex = undefined;
        continue;
      }
      if ((entry.kind !== 1 && entry.kind !== 2) || !entry.k) continue;

      if (entry.k.length === 1 && entry.k[0] === "requests") {
        // Full-array replacement - see the class doc comment above. Archive the outgoing turn
        // before this patch discards its `message` field for good.
        demote();
        const next: any[] = Array.isArray(entry.v) ? entry.v : [];
        currentTurn = next.length > 0 ? next[next.length - 1] : undefined;
        activeIndex = undefined; // this new turn's own index is unknown until its first patch
        continue;
      }

      if (entry.k[0] === "requests" && typeof entry.k[1] === "number") {
        const idx = entry.k[1];
        if (activeIndex === undefined && currentTurn) {
          // First patch seen since THIS turn was introduced - whichever index it uses IS this
          // turn's index from here on. CONFIRMED via a real regression case that an index can be
          // legitimately reused by a LATER turn once the earlier one that held it is done with it
          // (index 0 held the snapshot's own pre-existing turn, then was reused for the next live
          // turn's patches) - so this always claims/reclaims the index for the newly-introduced
          // turn, even if an earlier (already-archived) turn is still sitting there from before.
          // The earlier turn's own archived snapshot is unaffected - only where FUTURE patches for
          // this index route to changes.
          activeIndex = idx;
          turnByIndex.set(idx, currentTurn);
        }
        const target = turnByIndex.get(idx);
        if (target) deepSet(target, entry.k.slice(2), entry.v);
        // No turn has ever claimed this index - shouldn't happen given the sequencing above, but
        // drop it defensively rather than guessing which turn it might belong to.
        continue;
      }

      // Any other top-level field (sessionId, responderUsername, etc.)
      deepSet(topState, entry.k, entry.v);
    }
    demote();

    const sessionId: string = topState?.sessionId ?? path.basename(filePath, ".jsonl");

    if (archivedTurns.length > 0) {
      logger.info(`VscodeChatProvider: session ${sessionId} (${path.basename(filePath)}) has ${archivedTurns.length} turn(s)`);
    }

    archivedTurns.forEach((request, position) => {
      const requestId: string | undefined = request?.requestId;
      const turnKey = requestId ? `${sessionId}:${requestId}` : `${sessionId}:idx-${position}`;
      if (this.emittedTurnKeys.has(turnKey)) return;

      const fields = requestFieldsFrom(request);
      logger.info(
        `VscodeChatProvider: session ${sessionId} turn ${position} (${requestId ?? "no requestId"}) - promptLen=${fields.prompt.length} responseLen=${fields.response.length} hasResponse=${fields.hasResponse} isCanceled=${fields.isCanceled}`
      );
      if (!fields.prompt) return;

      // Only ever consider a turn ready once VS Code itself has marked THIS SPECIFIC reply as
      // finished (fields.hasFinalMarker, i.e. elapsedMs is set) - not by watching the response
      // text alone. CONFIRMED via real data on 2026-09-07: a genuinely still-running agent turn
      // (tool calls, file reads, quiet gaps well over one poll interval) can leave the visible
      // response text unchanged for multiple consecutive polls while 8 more real steps are still
      // to come - checking text stability alone captured a turn mid-sentence, 73 seconds before
      // it actually finished. Folding the response PART count into the stability value (not just
      // the text) closes the same class of gap the marker requirement doesn't cover on its own:
      // any new part at all, empty or not, breaks stability and restarts the 2-poll wait.
      // `isCanceled` with no response ever arriving is the one case with nothing more to wait
      // for, so it's still handled as its own path - kept behind the same stability check in case
      // the cancellation is itself reported before the object has finished settling.
      const settleValue = `${fields.responsePartCount}:${fields.response}`;
      let ready: boolean;
      if (fields.isCanceled && !fields.hasResponse) {
        ready = this.settleTracker.isStable(turnKey, settleValue);
      } else if (fields.hasFinalMarker) {
        ready = this.settleTracker.isStable(turnKey, settleValue);
      } else {
        logger.info(`VscodeChatProvider: session ${sessionId} turn ${position} - not finished yet (hasFinalMarker=${fields.hasFinalMarker}), waiting`);
        return;
      }
      logger.info(`VscodeChatProvider: session ${sessionId} turn ${position} - ready=${ready}`);
      if (!ready) return;

      onEvent({
        provider: this.id,
        providerDisplayName: topState?.responderUsername || this.displayName,
        captureMethod: "editor_chat_storage_poll",
        conversationId: sessionId,
        turnIndex: position,
        prompt: fields.prompt,
        response: fields.response,
        hasResponse: fields.hasResponse,
        settleReason: fields.isCanceled ? "canceled" : "response_settled",
        capturedAt: fields.timestamp ? new Date(fields.timestamp) : new Date(),
        url: `vscode-chat://session/${sessionId}`,
        hostname: "vscode-chat",
        path: `/session/${sessionId}`,
        pageTitle: "VS Code Chat",
        toolActivity: {
          filesReadCount: fields.usedFilesCount,
          filesEditedCount: fields.editedFilesCount,
          permissionPromptsCount: 0,
          toolCallsCount: fields.toolCallsCount,
        },
      });

      this.emittedTurnKeys.add(turnKey);
    });
  }
}

function deepSet(target: any, keyPath: KeyPath, value: unknown): void {
  let node = target;
  for (let i = 0; i < keyPath.length - 1; i++) {
    const key = keyPath[i];
    const nextKey = keyPath[i + 1];
    if (node[key] === undefined || node[key] === null) {
      node[key] = typeof nextKey === "number" ? [] : {};
    }
    node = node[key];
  }
  node[keyPath[keyPath.length - 1]] = value;
}

// CONFIRMED via real data on 2026-09-07 (conversation 48b90e1f): when the model's response narrates
// an inline file reference (rendered in the UI as a clickable "KT_Guide.md" chip), the response part
// for that chip is not plain text - it's a distinct { kind: "inlineReference", name, inlineReference }
// part with no `value`/`content` field at all. The old `part?.value ?? part?.content ?? ...` extractor
// silently dropped these parts entirely, leaving grammatical gaps like "Generated  at the repository
// root" (missing filename) or " has been added at the repository root" (missing subject). Extract the
// filename from `name` (falls back to the basename of the referenced path) so the chip's text survives.
function textOfResponsePart(part: any): string {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  if (part.kind === "inlineReference") {
    if (typeof part.name === "string" && part.name) return part.name;
    const refPath: string | undefined = part.inlineReference?.path ?? part.inlineReference?.fsPath;
    if (typeof refPath === "string" && refPath) {
      const base = refPath.split(/[\\/]/).pop();
      if (base) return base;
    }
    return "";
  }
  if (typeof part.value === "string") return part.value;
  if (typeof part.content === "string") return part.content;
  return "";
}

function requestFieldsFrom(request: any): {
  prompt: string;
  response: string;
  hasResponse: boolean;
  isCanceled: boolean;
  hasFinalMarker: boolean;
  responsePartCount: number;
  timestamp: number | undefined;
  usedFilesCount: number;
  editedFilesCount: number;
  toolCallsCount: number;
} {
  const prompt: string = request?.message?.text ?? request?.message ?? request?.prompt ?? "";

  const responseParts = Array.isArray(request?.response) ? request.response : [];
  const responseText = responseParts.map((part: any) => textOfResponsePart(part)).filter(Boolean).join("");
  const response: string = responseText || request?.result?.text || "";

  const usedContext = request?.usedContext?.documents ?? request?.contentReferences ?? [];
  const toolInvocations = responseParts.filter((p: any) => p?.kind === "toolInvocation" || p?.kind === "toolInvocationSerialized");

  return {
    prompt: typeof prompt === "string" ? prompt : "",
    response,
    hasResponse: response.length > 0 || request?.isComplete === true,
    isCanceled: request?.isCanceled === true,
    // CONFIRMED via real data on 2026-09-07: elapsedMs is set exactly once per request, on the
    // genuinely final patch, matching the real total duration (73871ms on a real turn the UI
    // itself reported as "Completed 12 steps in 1m 13s") - the same role Cursor's turnDurationMs
    // plays. A turn that's still working, however long its quiet gaps look, never has it yet.
    hasFinalMarker: request?.elapsedMs !== undefined,
    responsePartCount: responseParts.length,
    timestamp: request?.timestamp,
    usedFilesCount: Array.isArray(usedContext) ? usedContext.length : 0,
    editedFilesCount: 0,
    toolCallsCount: toolInvocations.length,
  };
}
