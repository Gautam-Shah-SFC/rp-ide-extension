import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { Provider, CaptureEventHandler } from "../class/Provider";
import { ToolActivitySummary } from "../class/CaptureEvent";
import { logger } from "../utils/logger";
import { loadKeySet, saveKeySet } from "./stateService";
import { tryAcquireLock, releaseLock } from "../utils/fileLock";
import { SettleTracker } from "./settleTracker";

const POLL_INTERVAL_MS = 20_000;

interface TranscriptEntry {
  step_index: number;
  source: string; // "USER_EXPLICIT" | "SYSTEM" | "MODEL"
  type: string; // "USER_INPUT" | "PLANNER_RESPONSE" | tool-step types (VIEW_FILE, LIST_DIRECTORY, ...) | "CHECKPOINT" | ...
  status: string;
  created_at?: string;
  content?: string;
  tool_calls?: { name?: string }[];
}

function isRunningInsideAntigravity(): boolean {
  // CONFIRMED via product.json on 2026-09-09: Antigravity's fork identifies itself as
  // nameLong/nameShort "Antigravity IDE" (applicationName "antigravity-ide"), which is what
  // vscode.env.appName reflects - same pattern as isRunningInsideCursor() in cursorChatService.ts.
  return vscode.env.appName.toLowerCase().includes("antigravity");
}

function isRealUserPrompt(entry: TranscriptEntry): boolean {
  return entry.source === "USER_EXPLICIT" && entry.type === "USER_INPUT";
}

// CONFIRMED via real data on 2026-09-09: a USER_INPUT entry's `content` is not just what the user
// typed - Antigravity wraps it as <USER_REQUEST>...</USER_REQUEST>, then appends its own
// <ADDITIONAL_METADATA> (active document, cursor position, other open files) and, when relevant,
// <USER_SETTINGS_CHANGE> blocks. Only the text inside <USER_REQUEST> is what the user actually
// typed; the rest is Antigravity's own injected context and must not be captured as "the prompt".
function extractUserRequest(rawContent: string): string {
  const match = rawContent.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  return (match ? match[1] : rawContent).trim();
}

/**
 * Antigravity (Google's agentic IDE) writes each conversation ("trajectory") as an append-only
 * JSONL transcript at ~/.gemini/antigravity-ide/brain/<conversationId>/.system_generated/logs/
 * transcript.jsonl - CONFIRMED via a real conversation on this machine on 2026-09-09. Each line is
 * one fully-written step ({step_index, source, type, status, content?, tool_calls?}); a real user
 * turn is {source:"USER_EXPLICIT", type:"USER_INPUT"}, and the model's actual answer text (as
 * opposed to its many intermediate tool-driven PLANNER_RESPONSE steps, which carry empty content)
 * shows up as the last PLANNER_RESPONSE with non-empty `content` before the next user turn.
 *
 * Deliberately scoped to `antigravity-ide/`, never `antigravity-cli/` - Antigravity itself keeps
 * IDE and standalone-CLI usage in two separate directory trees (unlike Claude Code, which needs an
 * explicit `entrypoint` field check - see claudeCodeService.ts), so pointing this provider only at
 * the `-ide` tree is a complete, structural CLI exclusion with no extra filtering needed.
 *
 * No confirmed explicit "turn genuinely done" signal was found (all `status` values seen so far are
 * "DONE" even mid-conversation, since each line is only written once complete - there's no partial-
 * write race, but also no equivalent of Claude Code's stop_reason or VS Code Chat's elapsedMs to
 * mark a REPLY as final rather than "the model paused before another tool call"). Settle detection
 * therefore uses SettleTracker (2-consecutive-poll stability), the same defensive fallback used for
 * Codex - refine once a real multi-turn session reveals a genuine completion marker.
 */
export class AntigravityProvider implements Provider {
  readonly id = "antigravity";
  readonly displayName = "Antigravity";

  private brainDir: string;
  private timer: NodeJS.Timeout | undefined;
  private emittedTurnKeys: Set<string> = new Set();
  private fileMtimeCache = new Map<string, number>();
  // CONFIRMED via real data on 2026-09-09 (conversation aa817511, second turn "create a KT_Giuie
  // for me"): the mtime-cache skip below is fundamentally incompatible with SettleTracker on its
  // own - once a transcript stops being written to (the normal case once a turn's real answer is
  // in), its mtime never changes again, so it's never re-read, so SettleTracker's required SECOND
  // observation of the same text never happens and the turn is captured never. A turn only "worked"
  // once before by accident (extra steps kept the file's mtime moving for ~40s past the real
  // answer, giving stability a second chance to fire). Any file that produced an unresolved
  // (non-stable) turn on its last pass is force-reprocessed on every subsequent poll regardless of
  // mtime, until it resolves - see pollOnceLocked/processTranscriptFile.
  private pendingFiles: Set<string> = new Set();
  private settleTracker = new SettleTracker();
  private lockPath: string;

  constructor(private readonly statePath: string) {
    this.brainDir = path.join(os.homedir(), ".gemini", "antigravity-ide", "brain");
    this.lockPath = `${statePath}.lock`;
  }

  async isAvailable(): Promise<boolean> {
    if (!isRunningInsideAntigravity()) return false;
    return fs.existsSync(this.brainDir);
  }

  async start(onEvent: CaptureEventHandler): Promise<void> {
    if (!(await this.isAvailable())) {
      logger.info("AntigravityProvider: not inside Antigravity or ~/.gemini/antigravity-ide/brain not found, skipping");
      return;
    }
    const poll = () => {
      try {
        this.pollOnce(onEvent);
      } catch (err) {
        logger.error("AntigravityProvider: poll failed", err);
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
    // See CursorChatProvider for why: multiple Antigravity windows share the same
    // ~/.gemini/antigravity-ide/brain and the same dedup-state file, so a lock + fresh reload per
    // poll is needed to avoid each window independently capturing/uploading the same turn.
    const token = tryAcquireLock(this.lockPath);
    if (!token) {
      logger.info("AntigravityProvider: another window is polling this cycle, skipping");
      return;
    }
    try {
      this.pollOnceLocked(onEvent);
    } finally {
      releaseLock(this.lockPath, token);
    }
  }

  private pollOnceLocked(onEvent: CaptureEventHandler): void {
    // First time this provider has ever run: capture only from now on, not this machine's entire
    // pre-existing Antigravity history. Everything found on this one pass gets silently marked as
    // already-seen (same code path, just a no-op onEvent) so later turns in the same conversations
    // are still correctly recognized as new.
    const isFirstRun = !fs.existsSync(this.statePath);
    const effectiveOnEvent: CaptureEventHandler = isFirstRun ? () => {} : onEvent;

    this.emittedTurnKeys = loadKeySet(this.statePath);
    const sizeBefore = this.emittedTurnKeys.size;
    let filesScanned = 0;
    let filesChanged = 0;

    for (const conversationDir of this.listConversationDirs()) {
      const file = this.transcriptFileFor(conversationDir);
      if (!file || !fs.existsSync(file)) continue;
      filesScanned++;
      const mtimeMs = fs.statSync(file).mtimeMs;
      const mtimeUnchanged = this.fileMtimeCache.get(file) === mtimeMs;
      if (mtimeUnchanged && !this.pendingFiles.has(file)) continue;
      filesChanged++;
      this.fileMtimeCache.set(file, mtimeMs);
      const hasPendingTurn = this.processTranscriptFile(file, path.basename(conversationDir), effectiveOnEvent);
      if (hasPendingTurn) {
        this.pendingFiles.add(file);
      } else {
        this.pendingFiles.delete(file);
      }
    }

    const changedThisPoll = this.emittedTurnKeys.size - sizeBefore;
    if (isFirstRun) {
      logger.info(`AntigravityProvider: first run - baselining ${changedThisPoll} pre-existing turn(s) as already-seen, will not be uploaded. Only new activity from here on will be captured.`);
    } else {
      logger.info(
        `AntigravityProvider: poll tick - ${filesScanned} transcript(s) scanned (${filesChanged} changed), ${changedThisPoll} new turn(s) emitted`
      );
    }
    if (changedThisPoll > 0 || isFirstRun) {
      saveKeySet(this.statePath, this.emittedTurnKeys);
    }
  }

  private listConversationDirs(): string[] {
    try {
      return fs
        .readdirSync(this.brainDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(this.brainDir, d.name));
    } catch {
      return [];
    }
  }

  private transcriptFileFor(conversationDir: string): string {
    return path.join(conversationDir, ".system_generated", "logs", "transcript.jsonl");
  }

  /** Returns true if this pass left at least one turn with a real (non-empty) response that
   * hasn't reached settle-stability yet - the caller must keep polling this file even if its
   * mtime stops changing, since that unresolved turn will otherwise never get a second look. */
  private processTranscriptFile(filePath: string, conversationId: string, onEvent: CaptureEventHandler): boolean {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return false;

    const entries: TranscriptEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        continue;
      }
    }

    let hasPendingTurn = false;
    let turnIndex = 0;
    let i = 0;
    while (i < entries.length) {
      const anchor = entries[i];
      if (!isRealUserPrompt(anchor)) {
        i++;
        continue;
      }

      const prompt = extractUserRequest(anchor.content ?? "");
      const turnKey = `${conversationId}:${anchor.step_index}`;

      let j = i + 1;
      const chain: TranscriptEntry[] = [];
      while (j < entries.length && !isRealUserPrompt(entries[j])) {
        chain.push(entries[j]);
        j++;
      }

      if (this.emittedTurnKeys.has(turnKey) || !prompt) {
        turnIndex++;
        i = j;
        continue;
      }

      const responseParts = chain
        .filter((e) => e.source === "MODEL" && e.type === "PLANNER_RESPONSE" && e.content)
        .map((e) => e.content as string);
      const response = responseParts.join("\n\n");
      const toolCallsCount = chain.reduce((sum, e) => sum + (e.tool_calls?.length ?? 0), 0);

      if (!response) {
        turnIndex++;
        i = j;
        continue;
      }

      const ready = this.settleTracker.isStable(turnKey, response);
      if (!ready) {
        hasPendingTurn = true;
        turnIndex++;
        i = j;
        continue;
      }

      const toolActivity: ToolActivitySummary = {
        filesReadCount: 0,
        filesEditedCount: 0,
        permissionPromptsCount: 0,
        toolCallsCount,
      };

      onEvent({
        provider: this.id,
        providerDisplayName: this.displayName,
        captureMethod: "editor_chat_storage_poll",
        conversationId,
        turnIndex,
        prompt,
        response,
        hasResponse: response.length > 0,
        settleReason: "response_settled",
        capturedAt: anchor.created_at ? new Date(anchor.created_at) : new Date(),
        url: `antigravity://conversation/${conversationId}`,
        hostname: "antigravity",
        path: `/conversation/${conversationId}`,
        pageTitle: "Antigravity",
        toolActivity,
      });

      this.emittedTurnKeys.add(turnKey);
      turnIndex++;
      i = j;
    }
    return hasPendingTurn;
  }
}
