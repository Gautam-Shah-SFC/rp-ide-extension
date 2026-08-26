import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Provider, CaptureEventHandler } from "../class/Provider";
import { ToolActivitySummary } from "../class/CaptureEvent";
import { logger } from "../utils/logger";
import { loadKeySet, saveKeySet } from "./stateService";
import { tryAcquireLock, releaseLock } from "../utils/fileLock";
import { SettleTracker } from "./settleTracker";

const POLL_INTERVAL_MS = 20_000;

interface ContentBlock {
  type: string;
  text?: string;
}

interface RolloutLine {
  timestamp?: string;
  ordinal?: number;
  type: string;
  payload?: any;
}

/**
 * Codex CLI (OpenAI's coding agent) writes each session as an append-only JSONL "rollout" file
 * at ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<sessionId>.jsonl. CONFIRMED by installing
 * Codex CLI 0.149.1 and inspecting a real session on this machine on 2026-08-25: each line is
 * {timestamp, ordinal, type, payload}; a real user prompt is
 * {type:"response_item", payload:{type:"message", role:"user", content:[{type:"input_text",
 * text:"..."}]}}, and an aborted turn produces {type:"event_msg", payload:{type:"turn_aborted"}}
 * - both verified against real local data. What's NOT verified: a genuinely completed assistant
 * reply, since testing here had no valid OpenAI API key to get past the auth step. Assumed to
 * mirror the same envelope with role:"assistant" and content type "output_text" (OpenAI's public
 * Responses API convention, which "response_item" clearly mirrors), but treated defensively -
 * like vscodeChatService.ts, a response is only trusted once its text is stable across
 * consecutive polls rather than assuming the first sighting is final. Refine once real completed
 * session data exists.
 */
export class CodexProvider implements Provider {
  readonly id = "codex";
  readonly displayName = "Codex CLI";

  private sessionsDir: string;
  private timer: NodeJS.Timeout | undefined;
  private emittedTurnKeys: Set<string> = new Set();
  private fileMtimeCache = new Map<string, number>();
  private settleTracker = new SettleTracker();
  private lockPath: string;

  constructor(private readonly statePath: string) {
    this.sessionsDir = path.join(os.homedir(), ".codex", "sessions");
    this.lockPath = `${statePath}.lock`;
  }

  async isAvailable(): Promise<boolean> {
    return fs.existsSync(this.sessionsDir);
  }

  async start(onEvent: CaptureEventHandler): Promise<void> {
    if (!(await this.isAvailable())) {
      logger.info("CodexProvider: ~/.codex/sessions not found, skipping");
      return;
    }
    const poll = () => {
      try {
        this.pollOnce(onEvent);
      } catch (err) {
        logger.error("CodexProvider: poll failed", err);
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
    // See CursorChatProvider for why: multiple IDE/terminal instances share the same
    // ~/.codex/sessions and the same dedup-state file, so a lock + fresh reload per poll is
    // needed to avoid each instance independently capturing/uploading the same turn.
    const token = tryAcquireLock(this.lockPath);
    if (!token) {
      logger.info("CodexProvider: another window is polling this cycle, skipping");
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
    // entire pre-existing Codex history. Everything found on this one pass gets silently marked
    // as already-seen (same code path, just a no-op onEvent) so later turns in the same
    // sessions are still correctly recognized as new.
    const isFirstRun = !fs.existsSync(this.statePath);
    const effectiveOnEvent: CaptureEventHandler = isFirstRun ? () => {} : onEvent;

    this.emittedTurnKeys = loadKeySet(this.statePath);
    const sizeBefore = this.emittedTurnKeys.size;
    let filesScanned = 0;
    let filesChanged = 0;

    for (const file of this.listRolloutFiles()) {
      filesScanned++;
      const mtimeMs = fs.statSync(file).mtimeMs;
      if (this.fileMtimeCache.get(file) === mtimeMs) continue;
      filesChanged++;
      this.fileMtimeCache.set(file, mtimeMs);
      this.processRolloutFile(file, effectiveOnEvent);
    }

    const changedThisPoll = this.emittedTurnKeys.size - sizeBefore;
    if (isFirstRun) {
      logger.info(
        `CodexProvider: first run - baselining ${changedThisPoll} pre-existing turn(s) as already-seen, will not be uploaded. Only new activity from here on will be captured.`
      );
    } else {
      logger.info(`CodexProvider: poll tick - ${filesScanned} rollout(s) scanned (${filesChanged} changed), ${changedThisPoll} new turn(s) emitted`);
    }
    if (changedThisPoll > 0 || isFirstRun) {
      saveKeySet(this.statePath, this.emittedTurnKeys);
    }
  }

  private listRolloutFiles(): string[] {
    const results: string[] = [];
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith(".jsonl")) {
          results.push(full);
        }
      }
    };
    walk(this.sessionsDir);
    return results;
  }

  private processRolloutFile(filePath: string, onEvent: CaptureEventHandler): void {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return;

    const lines: RolloutLine[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        lines.push(JSON.parse(line));
      } catch {
        continue;
      }
    }
    if (lines.length === 0) return;

    const metaLine = lines.find((l) => l.type === "session_meta");
    const sessionId: string = metaLine?.payload?.session_id ?? metaLine?.payload?.id ?? path.basename(filePath, ".jsonl");

    let turnIndex = 0;
    let i = 0;
    while (i < lines.length) {
      if (!isRealUserPrompt(lines[i])) {
        i++;
        continue;
      }

      const anchor = lines[i];
      const prompt = textOf(anchor.payload.content);
      const anchorId = anchor.payload.id ?? `${sessionId}-${turnIndex}`;
      const turnKey = `${sessionId}:${anchorId}`;

      let j = i + 1;
      const chain: RolloutLine[] = [];
      while (j < lines.length && !isRealUserPrompt(lines[j])) {
        chain.push(lines[j]);
        j++;
      }

      if (this.emittedTurnKeys.has(turnKey) || !prompt) {
        turnIndex++;
        i = j;
        continue;
      }

      const aborted = chain.some((l) => l.type === "event_msg" && l.payload?.type === "turn_aborted");
      const responseParts: string[] = [];
      for (const l of chain) {
        if (l.type !== "response_item" || l.payload?.type !== "message" || l.payload?.role !== "assistant") continue;
        for (const block of (l.payload?.content ?? []) as ContentBlock[]) {
          if ((block.type === "output_text" || block.type === "text") && block.text) {
            responseParts.push(block.text);
          }
        }
      }
      // Best-effort: OpenAI's Responses API convention for tool calls in this stream.
      const toolCallsCount = chain.filter(
        (l) => l.type === "response_item" && (l.payload?.type === "function_call" || l.payload?.type === "local_shell_call")
      ).length;

      const response = responseParts.join("\n\n");
      const hasResponse = response.length > 0;

      let ready: boolean;
      if (aborted && !hasResponse) {
        ready = true;
        this.settleTracker.clear(turnKey);
      } else if (hasResponse) {
        ready = this.settleTracker.isStable(turnKey, response);
      } else {
        ready = false;
      }

      if (!ready) {
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
        conversationId: sessionId,
        turnIndex,
        prompt,
        response,
        hasResponse,
        settleReason: aborted ? "canceled" : "response_settled",
        capturedAt: anchor.timestamp ? new Date(anchor.timestamp) : new Date(),
        url: `codex://session/${sessionId}`,
        hostname: "codex-cli",
        path: `/session/${sessionId}`,
        pageTitle: "Codex CLI",
        toolActivity,
      });

      this.emittedTurnKeys.add(turnKey);
      turnIndex++;
      i = j;
    }
  }
}

function isRealUserPrompt(line: RolloutLine): boolean {
  return (
    line.type === "response_item" &&
    line.payload?.type === "message" &&
    line.payload?.role === "user" &&
    Array.isArray(line.payload?.content) &&
    line.payload.content.some((c: ContentBlock) => c.type === "input_text")
  );
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((c) => (c.type === "input_text" || c.type === "text") && c.text)
    .map((c) => c.text as string)
    .join("\n\n");
}
