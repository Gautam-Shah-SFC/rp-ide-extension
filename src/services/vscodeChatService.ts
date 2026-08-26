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
 * VS Code's built-in Chat view (which hosts Copilot Chat as a "responder") persists each
 * session as an append-only JSONL event log: one "kind":0 full snapshot line followed by
 * "kind":1 incremental patch lines ({k: keyPath, v: newValue}). Verified the file locations
 * and this envelope format against a live install on 2026-08-24, but no populated conversation
 * was available to confirm the exact field names inside `requests[]` (message/response text).
 * requestFieldsFrom() below is a best-effort, defensive extractor - refine once real session
 * data with actual turns exists.
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

    let state: any = {};
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let entry: LogLine;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.kind === 0) {
        state = entry.v;
      } else if ((entry.kind === 1 || entry.kind === 2) && entry.k) {
        // kind:1 and kind:2 both carry the same {k, v} set-at-path shape (confirmed from a real
        // multi-turn session on 2026-08-25) - kind:2 is used at least for replacing the whole
        // `requests` array when a new turn starts, and for bulk-updating a request's `response`.
        // Previously only kind:1 was applied, so every turn after the first (already embedded in
        // the initial kind:0 snapshot) was silently invisible - this was the root cause of
        // "only the first message in a chat gets captured".
        deepSet(state, entry.k, entry.v);
      }
    }

    const sessionId: string = state?.sessionId ?? path.basename(filePath, ".jsonl");
    const requests: any[] = Array.isArray(state?.requests) ? state.requests : [];

    // Diagnostic-level verbosity while vscodeChatService's real field shapes are still
    // unverified - remove/quiet once a real capture confirms the parsing is correct.
    if (requests.length > 0) {
      logger.info(
        `VscodeChatProvider: session ${sessionId} (${path.basename(filePath)}) has ${requests.length} request(s), stateKeys=[${Object.keys(state ?? {}).join(",")}]`
      );
    }

    requests.forEach((request, index) => {
      const turnKey = `${sessionId}:${index}`;
      if (this.emittedTurnKeys.has(turnKey)) return;

      const fields = requestFieldsFrom(request);
      logger.info(
        `VscodeChatProvider: session ${sessionId} turn ${index} - requestKeys=[${Object.keys(request ?? {}).join(",")}] promptLen=${fields.prompt.length} responseLen=${fields.response.length} hasResponse=${fields.hasResponse} isCanceled=${fields.isCanceled}`
      );
      if (!fields.prompt) return;

      // Copilot streams its answer in stages (narration -> tool call -> more narration ->
      // final wrap-up); capturing on the first non-empty snapshot grabs a mid-stream fragment
      // and, combined with persisted turn dedup, would permanently lock in that truncated text.
      // Only treat it as done once the text stops changing across consecutive polls - unless it
      // was canceled before any response ever arrived, in which case nothing more is coming.
      //
      // NOTE: there is no permission-pause gate here (unlike Cursor's hasBlockingPendingActions,
      // which is confirmed against real data). An earlier attempt at one, gated on a guessed
      // isConfirmed/isComplete shape for tool-invocation parts, was removed after it turned out
      // to very likely false-positive on ordinary already-completed tool calls - which would
      // permanently block capture of any turn that used a tool at all (i.e. most agentic turns).
      // A wrong guess that blocks real captures is worse than the rare early-capture edge case
      // it was meant to prevent, so this needs real session data before being reintroduced.
      let ready: boolean;
      if (fields.isCanceled && !fields.hasResponse) {
        ready = true;
        this.settleTracker.clear(turnKey);
      } else if (fields.hasResponse) {
        ready = this.settleTracker.isStable(turnKey, fields.response);
      } else {
        logger.info(`VscodeChatProvider: session ${sessionId} turn ${index} - has a prompt but no response yet, waiting`);
        return;
      }
      logger.info(`VscodeChatProvider: session ${sessionId} turn ${index} - ready=${ready}`);
      if (!ready) return;

      onEvent({
        provider: this.id,
        providerDisplayName: state?.responderUsername || this.displayName,
        captureMethod: "editor_chat_storage_poll",
        conversationId: sessionId,
        turnIndex: index,
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

function requestFieldsFrom(request: any): {
  prompt: string;
  response: string;
  hasResponse: boolean;
  isCanceled: boolean;
  timestamp: number | undefined;
  usedFilesCount: number;
  editedFilesCount: number;
  toolCallsCount: number;
} {
  const prompt: string = request?.message?.text ?? request?.message ?? request?.prompt ?? "";

  const responseParts = Array.isArray(request?.response) ? request.response : [];
  const responseText = responseParts
    .map((part: any) => part?.value ?? part?.content ?? (typeof part === "string" ? part : ""))
    .filter(Boolean)
    .join("");
  const response: string = responseText || request?.result?.text || "";

  const usedContext = request?.usedContext?.documents ?? request?.contentReferences ?? [];
  const toolInvocations = responseParts.filter((p: any) => p?.kind === "toolInvocation" || p?.kind === "toolInvocationSerialized");

  return {
    prompt: typeof prompt === "string" ? prompt : "",
    response,
    hasResponse: response.length > 0 || request?.isComplete === true,
    isCanceled: request?.isCanceled === true,
    timestamp: request?.timestamp,
    usedFilesCount: Array.isArray(usedContext) ? usedContext.length : 0,
    editedFilesCount: 0,
    toolCallsCount: toolInvocations.length,
  };
}
