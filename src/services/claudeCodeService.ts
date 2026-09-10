import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Provider, CaptureEventHandler } from "../class/Provider";
import { ToolActivitySummary } from "../class/CaptureEvent";
import { logger } from "../utils/logger";
import { loadKeySet, saveKeySet } from "./stateService";
import { tryAcquireLock, releaseLock } from "../utils/fileLock";

const POLL_INTERVAL_MS = 20_000;
const READ_TOOL_NAMES = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch", "NotebookEdit"]);
const EDIT_TOOL_NAMES = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
}

interface TranscriptEntry {
  type: string;
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  entrypoint?: string;
  message?: {
    role?: string;
    content?: ContentBlock[];
    stop_reason?: string;
  };
  attachment?: {
    type?: string;
    prompt?: ContentBlock[];
  };
}

/**
 * Claude Code (CLI or the editor's Claude Code integration - same underlying transcript format
 * either way, distinguished per-entry by `entrypoint`: "claude-vscode" vs "cli" - see the check in
 * processTranscriptFile) writes each conversation as an append-only JSONL file at
 * ~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl,
 * one full JSON object per line - unlike Cursor/VS Code Chat's mutating state files, each line here
 * is written once its message is complete, so there's no partial/streaming-text case to guard
 * against. A "turn" is one real user text message followed by a chain of assistant messages
 * (which may include tool_use/tool_result round-trips); the chain is genuinely finished once an
 * assistant message has stop_reason "end_turn" (Claude API's own turn-completion signal, not a
 * guess) - stop_reason "tool_use" means more is coming, whether running or awaiting permission.
 * Verified against a real multi-tool-call session on 2026-08-25.
 */
export class ClaudeCodeProvider implements Provider {
  readonly id = "claude_code";
  readonly displayName = "Claude Code";

  private projectsDir: string;
  private timer: NodeJS.Timeout | undefined;
  private emittedTurnKeys: Set<string> = new Set();
  private fileMtimeCache = new Map<string, number>();
  private lockPath: string;

  constructor(private readonly statePath: string) {
    this.projectsDir = path.join(os.homedir(), ".claude", "projects");
    this.lockPath = `${statePath}.lock`;
  }

  async isAvailable(): Promise<boolean> {
    return fs.existsSync(this.projectsDir);
  }

  async start(onEvent: CaptureEventHandler): Promise<void> {
    if (!(await this.isAvailable())) {
      logger.info("ClaudeCodeProvider: ~/.claude/projects not found, skipping");
      return;
    }
    const poll = () => {
      try {
        this.pollOnce(onEvent);
      } catch (err) {
        logger.error("ClaudeCodeProvider: poll failed", err);
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
    // See CursorChatProvider for why: multiple IDE windows share the same ~/.claude/projects
    // and the same dedup-state file, so a lock + fresh reload per poll is needed to avoid each
    // window independently capturing/uploading the same turn.
    const token = tryAcquireLock(this.lockPath);
    if (!token) {
      logger.info("ClaudeCodeProvider: another window is polling this cycle, skipping");
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
    // entire pre-existing Claude Code history. Everything found on this one pass gets silently
    // marked as already-seen (same code path, just a no-op onEvent) so later turns in the same
    // sessions are still correctly recognized as new.
    const isFirstRun = !fs.existsSync(this.statePath);
    const effectiveOnEvent: CaptureEventHandler = isFirstRun ? () => {} : onEvent;

    this.emittedTurnKeys = loadKeySet(this.statePath);
    const sizeBefore = this.emittedTurnKeys.size;
    let filesScanned = 0;
    let filesChanged = 0;

    for (const projectDir of this.listProjectDirs()) {
      for (const file of this.listTranscriptFiles(projectDir)) {
        filesScanned++;
        const mtimeMs = fs.statSync(file).mtimeMs;
        if (this.fileMtimeCache.get(file) === mtimeMs) continue;
        filesChanged++;
        this.fileMtimeCache.set(file, mtimeMs);
        this.processTranscriptFile(file, effectiveOnEvent);
      }
    }

    const changedThisPoll = this.emittedTurnKeys.size - sizeBefore;
    if (isFirstRun) {
      logger.info(`ClaudeCodeProvider: first run - baselining ${changedThisPoll} pre-existing turn(s) as already-seen, will not be uploaded. Only new activity from here on will be captured.`);
    } else {
      logger.info(
        `ClaudeCodeProvider: poll tick - ${filesScanned} transcript(s) scanned (${filesChanged} changed), ${changedThisPoll} new turn(s) emitted`
      );
    }
    if (changedThisPoll > 0 || isFirstRun) {
      saveKeySet(this.statePath, this.emittedTurnKeys);
    }
  }

  private listProjectDirs(): string[] {
    try {
      return fs
        .readdirSync(this.projectsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(this.projectsDir, d.name));
    } catch {
      return [];
    }
  }

  private listTranscriptFiles(projectDir: string): string[] {
    try {
      return fs
        .readdirSync(projectDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => path.join(projectDir, f));
    } catch {
      return [];
    }
  }

  private processTranscriptFile(filePath: string, onEvent: CaptureEventHandler): void {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return;

    const entries: TranscriptEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if ((parsed.type === "user" || parsed.type === "assistant") && Array.isArray(parsed.message?.content)) {
          entries.push(parsed);
        } else if (parsed.type === "attachment" && parsed.attachment?.type === "queued_command" && Array.isArray(parsed.attachment?.prompt)) {
          // CONFIRMED via real data on 2026-09-09 (this exact session, mid-turn message "yeah but
          // that tag won't be shared..."): a message sent while a turn is still running is NOT
          // stored as a type:"user" entry - it's a distinct { type:"attachment", attachment:
          // {type:"queued_command", prompt:[...]} } shape that lands mid-chain, addressed by the
          // SAME ongoing response as the turn it interrupted. Kept as its own entry kind (not
          // pushed as if it were a real anchor) so it can be folded into the enclosing turn's
          // prompt text below, instead of silently vanishing.
          entries.push(parsed);
        }
      } catch {
        continue;
      }
    }

    let turnIndex = 0;
    let i = 0;
    while (i < entries.length) {
      const anchor = entries[i];
      if (!isRealUserPrompt(anchor)) {
        i++;
        continue;
      }

      const sessionId = anchor.sessionId ?? path.basename(filePath, ".jsonl");
      const turnKey = `${sessionId}:${anchor.uuid ?? turnIndex}`;

      // Collect the response chain: everything up to (not including) the next real user prompt.
      let j = i + 1;
      const chain: TranscriptEntry[] = [];
      while (j < entries.length && !isRealUserPrompt(entries[j])) {
        chain.push(entries[j]);
        j++;
      }

      const queuedMidTurnTexts = chain
        .filter((e) => e.type === "attachment" && e.attachment?.type === "queued_command")
        .map((e) => textOf(e.attachment?.prompt ?? []))
        .filter(Boolean);
      const prompt = [textOf(anchor.message?.content ?? []), ...queuedMidTurnTexts].filter(Boolean).join("\n\n");

      if (this.emittedTurnKeys.has(turnKey)) {
        turnIndex++;
        i = j;
        continue;
      }

      // CONFIRMED via real data on 2026-09-09 (session f531d3b0, project FL-Nova): Claude Code
      // stamps every entry with `entrypoint` - "claude-vscode" when run through the IDE's Claude
      // Code integration, "cli" when run from a standalone terminal - and a single session can
      // genuinely switch between the two mid-conversation (this real session did, on 2026-09-08).
      // Retroper is scoped to IDE activity only: a "cli" anchor is marked seen (so it's never
      // rechecked) but never captured/uploaded.
      if (anchor.entrypoint === "cli") {
        this.emittedTurnKeys.add(turnKey);
        turnIndex++;
        i = j;
        continue;
      }

      const assistantEntries = chain.filter((e) => e.type === "assistant");
      const responseParts: string[] = [];
      let toolCallsCount = 0;
      let filesReadCount = 0;
      let filesEditedCount = 0;
      let lastStopReason: string | undefined;

      for (const entry of assistantEntries) {
        lastStopReason = entry.message?.stop_reason ?? lastStopReason;
        for (const block of entry.message?.content ?? []) {
          if (block.type === "text" && block.text) {
            responseParts.push(block.text);
          } else if (block.type === "tool_use") {
            toolCallsCount++;
            if (block.name && READ_TOOL_NAMES.has(block.name)) filesReadCount++;
            if (block.name && EDIT_TOOL_NAMES.has(block.name)) filesEditedCount++;
          }
        }
      }

      const response = responseParts.join("\n\n");
      const settled = lastStopReason === "end_turn";

      if (!prompt) {
        turnIndex++;
        i = j;
        continue;
      }
      if (!settled) {
        turnIndex++;
        i = j;
        continue;
      }

      const toolActivity: ToolActivitySummary = {
        filesReadCount,
        filesEditedCount,
        permissionPromptsCount: 0,
        toolCallsCount,
      };

      onEvent({
        provider: this.id,
        providerDisplayName: this.displayName,
        captureMethod: "editor_chat_storage_poll",
        conversationId: sessionId,
        turnIndex,
        prompt,
        response,
        hasResponse: response.length > 0,
        settleReason: "response_settled",
        capturedAt: anchor.timestamp ? new Date(anchor.timestamp) : new Date(),
        url: `claude-code://session/${sessionId}`,
        hostname: "claude-code",
        path: `/session/${sessionId}`,
        pageTitle: "Claude Code",
        toolActivity,
      });

      this.emittedTurnKeys.add(turnKey);
      turnIndex++;
      i = j;
    }
  }
}

function isRealUserPrompt(entry: TranscriptEntry): boolean {
  if (entry.type !== "user") return false;
  const content = entry.message?.content ?? [];
  return content.length > 0 && content.every((c) => c.type === "text");
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text as string)
    .join("\n\n");
}
