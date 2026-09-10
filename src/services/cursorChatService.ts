import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import initSqlJs, { Database as SqlJsDatabase, SqlJsStatic } from "sql.js";
import { Provider, CaptureEventHandler } from "../class/Provider";
import { ToolActivitySummary } from "../class/CaptureEvent";
import { ideUserDataDir } from "../utils/pathUtils";
import { logger } from "../utils/logger";
import { loadKeySet, saveKeySet } from "./stateService";
import { SettleTracker } from "./settleTracker";
import { tryAcquireLock, releaseLock } from "../utils/fileLock";

const POLL_INTERVAL_MS = 20_000;
// Generous on purpose - the longest real agent turn seen so far ran ~3.5 minutes, so this leaves
// wide headroom before ever giving up on something still genuinely working.
const MAX_WAIT_MS = 20 * 60_000;

interface ConversationHeader {
  bubbleId: string;
  type: number;
  // turnDurationMs is CONFIRMED present only on a turn's genuinely final bubble (the one Cursor
  // itself considers the end of that reply) - see the ready-check below for why this matters.
  grouping?: { isRenderable?: boolean; hasText?: boolean; turnDurationMs?: number };
  createdAt: string;
}

interface ComposerData {
  composerId: string;
  status?: string;
  fullConversationHeadersOnly?: ConversationHeader[];
  // CONFIRMED via real data on 2026-09-01: Cursor's agent mode can spawn a genuinely separate
  // composer record (its own composerData:<id> entry, own bubbles, own status) to run a
  // sub-agent tool call (e.g. the "explore" subagent behind a task_v2 tool invocation) - its
  // "user" bubble is text the AI itself generated as the sub-agent's instructions, not anything
  // the human typed. subagentInfo.parentComposerId is present only on these - real, top-level,
  // user-initiated composers never have it. Without this check, a sub-agent's internal task gets
  // captured and uploaded as if it were a real user prompt (verified: a real "explore repo
  // architecture" sub-agent task got captured this way, attributed as if the user had typed it).
  subagentInfo?: { parentComposerId?: string };
  // Real, populated fields (verified 2026-09-01: 56057/200000 on an actual long conversation) -
  // how much of the model's context window this composer has used so far. Not a per-turn
  // output-length/truncation signal (no such marker was found anywhere in real bubble or composer
  // data), just useful supporting context attached to a turn that had to be given up on below.
  contextTokensUsed?: number;
  contextTokenLimit?: number;
}

interface Bubble {
  type: number;
  text?: string;
  toolResults?: unknown[];
  relevantFiles?: unknown[];
  attachedCodeChunks?: unknown[];
  newlyCreatedFiles?: unknown[];
}

interface Row {
  key?: string;
  composerId?: string;
  value: string;
}

// Structural (not imported) shape of the subset of node:sqlite's DatabaseSync API used here -
// avoids depending on @types/node shipping node:sqlite typings, which varies by version.
interface NodeSqliteDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}
type NodeSqliteCtor = new (path: string, opts: { readOnly: boolean }) => NodeSqliteDb;

let nodeSqliteChecked = false;
let nodeSqliteCtor: NodeSqliteCtor | undefined;

/** node:sqlite is compiled into the Node/Electron runtime itself (Node 22+) - unlike
 * better-sqlite3, there's no separate native .node binary that can go ABI-stale across IDEs/
 * versions, so it's safe to try opportunistically and fall back cleanly if it's not present. */
function tryLoadNodeSqlite(): NodeSqliteCtor | undefined {
  if (nodeSqliteChecked) return nodeSqliteCtor;
  nodeSqliteChecked = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("node:sqlite");
    nodeSqliteCtor = mod.DatabaseSync;
    logger.info("CursorChatProvider: using node:sqlite (live WAL-aware reads)");
  } catch (err) {
    logger.warn(
      `CursorChatProvider: node:sqlite not available in this runtime, falling back to sql.js snapshot reads - recent chats may not appear until Cursor checkpoints its WAL file. (${String(err)})`
    );
  }
  return nodeSqliteCtor;
}

let sqlJsPromise: Promise<SqlJsStatic> | undefined;

function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    const wasmPath = path.join(path.dirname(require.resolve("sql.js")), "sql-wasm.wasm");
    sqlJsPromise = initSqlJs({ locateFile: () => wasmPath });
  }
  return sqlJsPromise;
}

/** Wraps either a live node:sqlite connection (preferred - sees WAL data immediately, same as
 * Cursor's own reads) or a sql.js byte-snapshot (fallback) behind one query interface. */
class CursorDb {
  private mode: "node-sqlite" | "sqljs" = "sqljs";
  private nodeDb: NodeSqliteDb | undefined;
  private sqljsDb: SqlJsDatabase | undefined;

  static async open(dbPath: string): Promise<CursorDb> {
    const db = new CursorDb();
    const Ctor = tryLoadNodeSqlite();
    if (Ctor) {
      try {
        db.nodeDb = new Ctor(dbPath, { readOnly: true });
        db.mode = "node-sqlite";
        return db;
      } catch (err) {
        logger.warn(`CursorChatProvider: node:sqlite failed to open the db, falling back to sql.js for this poll: ${String(err)}`);
      }
    }
    const SQL = await getSqlJs();
    db.sqljsDb = new SQL.Database(fs.readFileSync(dbPath));
    db.mode = "sqljs";
    return db;
  }

  queryAll(sql: string, params: (string | number)[] = []): Row[] {
    if (this.mode === "node-sqlite") {
      return this.nodeDb!.prepare(sql).all(...params) as Row[];
    }
    const result = this.sqljsDb!.exec(sql, params);
    if (!result.length) return [];
    const { columns, values } = result[0];
    return values.map((row) => {
      const obj: Record<string, unknown> = {};
      columns.forEach((col, i) => (obj[col] = row[i]));
      return obj as unknown as Row;
    });
  }

  close(): void {
    if (this.mode === "node-sqlite") {
      this.nodeDb?.close();
    } else {
      this.sqljsDb?.close();
    }
  }
}

/** True only when this extension instance is actually running inside Cursor itself, not some
 * other VS Code-based IDE that merely happens to have Cursor also installed on the same machine.
 * CONFIRMED necessary via real evidence on 2026-09-01: state.vscdb lives at a fixed, well-known
 * path independent of which app is hosting the extension, so without this check a VS Code-hosted
 * Retroper install would also happily scan Cursor's chat data - and since each host keeps its own
 * separate dedup-state file (globalStorageUri differs per app), the SAME Cursor turn would get
 * captured and uploaded once by each host, with the cross-process file lock providing no
 * protection at all (it's also scoped per-host, not actually shared between them). */
function isRunningInsideCursor(): boolean {
  return vscode.env.appName.toLowerCase().includes("cursor");
}

/**
 * Cursor persists chat/agent sessions ("composers") in its global state.vscdb:
 * - cursorDiskKV["composerData:<composerId>"] -> session metadata + ordered message headers
 * - cursorDiskKV["bubbleId:<composerId>:<bubbleId>"] -> one message (type 1 = user, type 2 = assistant)
 * Verified against a live Cursor install on 2026-08-24. Tool-call/permission fields (toolResults
 * etc.) were empty in every sample seen so far, so filesRead/permission counts are best-effort
 * and will need refinement once real tool-use data is available.
 */
export class CursorChatProvider implements Provider {
  readonly id = "cursor";
  readonly displayName = "Cursor";

  private dbPath: string;
  private timer: NodeJS.Timeout | undefined;
  private emittedTurnKeys: Set<string> = new Set();
  private settleTracker = new SettleTracker();
  private lockPath: string;
  // First-seen time per not-yet-captured turnKey, so a turn that never gets a genuine completion
  // signal (no turnDurationMs marker ever appears - e.g. a genuinely stuck/crashed agent run) can
  // eventually be given up on instead of held forever and silently lost. In-memory only - losing
  // this on an extension restart just resets the wait, which is harmless (worst case: waits the
  // full period again). See the ready-check below for where this is used.
  private pendingSince = new Map<string, number>();

  constructor(private readonly statePath: string) {
    this.dbPath = path.join(ideUserDataDir("Cursor"), "globalStorage", "state.vscdb");
    this.lockPath = `${statePath}.lock`;
  }

  async isAvailable(): Promise<boolean> {
    if (!isRunningInsideCursor()) return false;
    return fs.existsSync(this.dbPath);
  }

  async start(onEvent: CaptureEventHandler): Promise<void> {
    if (!(await this.isAvailable())) {
      logger.info("CursorChatProvider: state.vscdb not found, skipping");
      return;
    }
    const poll = () => {
      this.pollOnce(onEvent).catch((err) => logger.error("CursorChatProvider: poll failed", err));
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

  private async pollOnce(onEvent: CaptureEventHandler): Promise<void> {
    // Other IDE windows run their own instance of this same provider against the same global
    // db and the same shared dedup-state file - reload it fresh (not just our in-memory copy
    // from construction time) and hold a cross-process lock for the duration, or two windows
    // can each decide the same turn is "new" and both capture/upload it.
    const token = tryAcquireLock(this.lockPath);
    if (!token) {
      logger.info("CursorChatProvider: another window is polling this cycle, skipping");
      return;
    }
    try {
      await this.pollOnceLocked(onEvent);
    } finally {
      releaseLock(this.lockPath, token);
    }
  }

  private async pollOnceLocked(onEvent: CaptureEventHandler): Promise<void> {
    // First time this provider has ever run (no state file yet): capture only from now on,
    // not this machine's entire pre-existing history. Everything found on this one pass gets
    // silently marked as already-seen (via the same code path, just with a no-op onEvent) so
    // future turns in the same conversations are still correctly recognized as new.
    const isFirstRun = !fs.existsSync(this.statePath);
    const effectiveOnEvent: CaptureEventHandler = isFirstRun ? () => {} : onEvent;

    this.emittedTurnKeys = loadKeySet(this.statePath);
    const sizeBefore = this.emittedTurnKeys.size;
    const db = await CursorDb.open(this.dbPath);
    let composerCount = 0;
    let pendingCount = 0;
    try {
      // composerHeaders (a separate table from the composerData blobs below) carries
      // hasBlockingPendingActions - true while the agent is paused waiting on a user decision
      // (e.g. a permission/approval prompt). Its response text looks "stable" only because
      // nothing is happening yet, not because it's actually finished - must not capture then.
      const pendingActionMap = new Map<string, boolean>();
      for (const row of db.queryAll("SELECT composerId, value FROM composerHeaders")) {
        if (!row.composerId) continue;
        try {
          const head = JSON.parse(row.value);
          if (head.hasBlockingPendingActions === true) {
            pendingActionMap.set(row.composerId, true);
            pendingCount++;
          }
        } catch {
          // ignore unparsable header row
        }
      }

      const composerRows = db.queryAll("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'");
      composerCount = composerRows.length;
      for (const row of composerRows) {
        if (row.key === "composerData:empty-state-draft") continue;
        this.processComposer(db, row.value, pendingActionMap, effectiveOnEvent);
      }
    } finally {
      db.close();
    }
    const changedThisPoll = this.emittedTurnKeys.size - sizeBefore;
    if (isFirstRun) {
      logger.info(`CursorChatProvider: first run - baselining ${changedThisPoll} pre-existing turn(s) as already-seen, will not be uploaded. Only new activity from here on will be captured.`);
    } else {
      logger.info(
        `CursorChatProvider: poll tick - ${composerCount} composer(s) scanned, ${pendingCount} waiting on a permission/approval prompt, ${changedThisPoll} new turn(s) emitted`
      );
    }
    if (changedThisPoll > 0 || isFirstRun) {
      // Always persist on the first run, even with 0 pre-existing turns, so an empty result
      // still creates the state file - otherwise the next poll would think it's still "first
      // run" and keep re-baselining instead of settling into normal capture.
      saveKeySet(this.statePath, this.emittedTurnKeys);
    }
  }

  private processComposer(
    db: CursorDb,
    rawValue: string,
    pendingActionMap: Map<string, boolean>,
    onEvent: CaptureEventHandler
  ): void {
    let composer: ComposerData;
    try {
      composer = JSON.parse(rawValue);
    } catch {
      return;
    }
    // A sub-agent's own internal composer, not a real user-initiated conversation - see the
    // ComposerData.subagentInfo doc comment above for what this is and why it's skipped entirely.
    if (composer.subagentInfo?.parentComposerId) return;
    const hasBlockingPendingAction = pendingActionMap.get(composer.composerId) === true;
    const headers = composer.fullConversationHeadersOnly ?? [];

    let turnIndex = 0;
    let i = 0;
    while (i < headers.length) {
      const userHeader = headers[i];
      if (userHeader.type !== 1) {
        i++;
        continue;
      }

      // Collect the FULL assistant run following this user message - everything up to (not
      // including) the next user header. CONFIRMED via a real agent-mode conversation on
      // 2026-09-01 that a single reply commonly spans several bubbles (a "thinking" bubble with
      // no text, one or more tool-call bubbles with no text, short narration bubbles, and the
      // actual final answer several bubbles later) - previously only headers[i+1] was read as
      // "the" response, which for this real conversation was an empty thinking bubble, so the
      // turn got captured with prompt present and response permanently empty. Concatenating every
      // non-empty text bubble in the run (same pattern already used for Claude Code/Codex/VS Code
      // Chat's multi-block responses) captures the real final answer along with any narration.
      let j = i + 1;
      const assistantHeaders: ConversationHeader[] = [];
      while (j < headers.length && headers[j].type !== 1) {
        assistantHeaders.push(headers[j]);
        j++;
      }

      const turnKey = `${composer.composerId}:${userHeader.bubbleId}`;
      if (this.emittedTurnKeys.has(turnKey)) {
        turnIndex++;
        i = j;
        continue;
      }

      const userBubble = this.readBubble(db, composer.composerId, userHeader.bubbleId);
      const assistantBubbles = assistantHeaders.map((h) => this.readBubble(db, composer.composerId, h.bubbleId));
      const response = assistantBubbles
        .map((b) => b?.text)
        .filter((t): t is string => !!t)
        .join("\n\n");
      const hasResponse = response.length > 0;

      const prompt = userBubble?.text ?? "";
      if (!prompt) {
        turnIndex++;
        i = j;
        continue;
      }

      // Only ever consider a turn ready once Cursor itself has marked THIS SPECIFIC reply as
      // finished - not based on composer.status, which turned out to be unreliable for this.
      //
      // CONFIRMED via real data on 2026-09-01: composer.status stops being "in_progress" well
      // before a long multi-phase agent turn is actually done - a real "generate the KT_Guide in
      // pdf form" request kept appending tool-call/thinking bubbles for over 3 minutes (38 headers
      // total) while status was already non-"in_progress", so gating on composer.status alone
      // (an earlier version of this fix) still captured early, locking in just the first bit of
      // narration. The reliable signal turns out to be per-bubble: Cursor stamps `turnDurationMs`
      // onto a header's `grouping` field ONLY on the bubble it considers the true end of that
      // reply (confirmed on both a 3.7s "Hello" and this real 186815ms/~3.1min KT_Guide turn) -
      // every other bubble in the run, however long the run is, lacks it. Requiring the LAST
      // assistant header in this turn's run to carry that marker means a run that's still growing
      // (more bubbles yet to come, marker not there yet) is never mistaken for done, regardless of
      // how long a quiet gap in the middle looks. `aborted` is the one status that's proven
      // reliable (verified against several real canceled-before-replying turns) and never gets a
      // turnDurationMs marker, since nothing more is ever coming - so it's still handled as its
      // own path. Either way, a stability check across 2 consecutive polls still guards the
      // separate race where the marker/status appears before the bubble's own text has finished
      // being written.
      //
      // CONFIRMED via real data on 2026-09-01 that `aborted` is NOT always terminal either: a
      // real turn's status flipped to "aborted" while 21 MORE tool-call bubbles were still added
      // over the following minute (60 headers total, none ever getting a turnDurationMs marker).
      // The capture that slipped through happened because stability was checked against `response`
      // alone - and a run of pure tool-call bubbles (empty text: reading files, running shell
      // commands) leaves the concatenated response text completely unchanged for many polls in a
      // row even while the bubble count keeps climbing, so it looked "stable" while very much still
      // running. Folding the assistant bubble COUNT into the tracked value closes this - any new
      // bubble at all, empty or not, breaks stability and restarts the 2-poll wait, so a run that's
      // still actively growing can never be mistaken for finished merely because nothing new is
      // visible yet.
      const lastAssistantHeader = assistantHeaders[assistantHeaders.length - 1];
      const hasFinalMarker = lastAssistantHeader?.grouping?.turnDurationMs !== undefined;
      const isAborted = composer.status === "aborted";
      const settleValue = `${assistantHeaders.length}:${response}`;
      let ready: boolean;
      if (hasBlockingPendingAction) {
        ready = false;
      } else if (hasFinalMarker || isAborted) {
        ready = this.settleTracker.isStable(turnKey, settleValue);
      } else {
        ready = false;
      }

      // Nothing above ever declares a turn ready without a genuine completion signal from
      // Cursor - which means a turn that never gets one (a crashed/stuck agent run, or any other
      // reason it just never resolves) would otherwise wait forever and silently never reach the
      // backend at all. Give up after MAX_WAIT_MS since the turn was first seen and send whatever
      // exists at that point instead - clearly tagged via settleReason so it's not mistaken for a
      // normal completion - rather than losing it entirely.
      let gaveUp = false;
      if (!ready) {
        const firstSeen = this.pendingSince.get(turnKey);
        if (firstSeen === undefined) {
          this.pendingSince.set(turnKey, Date.now());
        } else if (Date.now() - firstSeen > MAX_WAIT_MS) {
          ready = true;
          gaveUp = true;
        }
      }
      if (!ready) {
        turnIndex++;
        i = j;
        continue;
      }

      const toolActivity = this.extractToolActivity(userBubble, assistantBubbles);

      onEvent({
        provider: this.id,
        providerDisplayName: this.displayName,
        captureMethod: "editor_chat_storage_poll",
        conversationId: composer.composerId,
        turnIndex,
        prompt,
        response,
        hasResponse,
        settleReason: gaveUp ? "gave_up_waiting" : (composer.status ?? "unknown"),
        capturedAt: new Date(userHeader.createdAt),
        url: `cursor://composer/${composer.composerId}`,
        hostname: "cursor.app",
        path: `/composer/${composer.composerId}`,
        pageTitle: "Cursor Chat",
        toolActivity,
        contextTokensUsed: composer.contextTokensUsed,
        contextTokenLimit: composer.contextTokenLimit,
      });

      this.emittedTurnKeys.add(turnKey);
      this.pendingSince.delete(turnKey);
      turnIndex++;
      i = j;
    }
  }

  private readBubble(db: CursorDb, composerId: string, bubbleId: string): Bubble | undefined {
    const rows = db.queryAll("SELECT value FROM cursorDiskKV WHERE key = ?", [`bubbleId:${composerId}:${bubbleId}`]);
    if (!rows.length) return undefined;
    try {
      return JSON.parse(rows[0].value);
    } catch {
      return undefined;
    }
  }

  private extractToolActivity(userBubble: Bubble | undefined, assistantBubbles: (Bubble | undefined)[]): ToolActivitySummary {
    // A real agent-mode reply can span several assistant bubbles (thinking, tool calls, final
    // answer) - aggregate across all of them, not just one, to match how `response` is now built.
    const toolResults = assistantBubbles.flatMap((b) => b?.toolResults ?? []);
    const assistantRelevantFiles = assistantBubbles.flatMap((b) => b?.relevantFiles ?? []);
    const relevantFiles = assistantRelevantFiles.length > 0 ? assistantRelevantFiles : (userBubble?.relevantFiles ?? []);
    const newlyCreatedFiles = assistantBubbles.flatMap((b) => b?.newlyCreatedFiles ?? []);

    return {
      filesReadCount: relevantFiles.length,
      filesEditedCount: newlyCreatedFiles.length,
      permissionPromptsCount: 0,
      toolCallsCount: toolResults.length,
    };
  }
}
