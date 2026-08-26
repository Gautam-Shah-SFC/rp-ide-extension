import * as fs from "fs";
import * as path from "path";
import initSqlJs, { Database as SqlJsDatabase, SqlJsStatic } from "sql.js";
import { Provider, CaptureEventHandler } from "../class/Provider";
import { ToolActivitySummary } from "../class/CaptureEvent";
import { ideUserDataDir } from "../utils/pathUtils";
import { logger } from "../utils/logger";
import { loadKeySet, saveKeySet } from "./stateService";
import { SettleTracker } from "./settleTracker";
import { tryAcquireLock, releaseLock } from "../utils/fileLock";

const POLL_INTERVAL_MS = 20_000;

interface ConversationHeader {
  bubbleId: string;
  type: number;
  grouping?: { isRenderable?: boolean; hasText?: boolean };
  createdAt: string;
}

interface ComposerData {
  composerId: string;
  status?: string;
  fullConversationHeadersOnly?: ConversationHeader[];
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

  constructor(private readonly statePath: string) {
    this.dbPath = path.join(ideUserDataDir("Cursor"), "globalStorage", "state.vscdb");
    this.lockPath = `${statePath}.lock`;
  }

  async isAvailable(): Promise<boolean> {
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
    const hasBlockingPendingAction = pendingActionMap.get(composer.composerId) === true;
    const headers = composer.fullConversationHeadersOnly ?? [];

    let turnIndex = 0;
    for (let i = 0; i < headers.length; i++) {
      const userHeader = headers[i];
      if (userHeader.type !== 1) continue;
      const assistantHeader = headers[i + 1]?.type === 2 ? headers[i + 1] : undefined;

      const turnKey = `${composer.composerId}:${userHeader.bubbleId}`;
      if (this.emittedTurnKeys.has(turnKey)) continue;

      const userBubble = this.readBubble(db, composer.composerId, userHeader.bubbleId);
      const assistantBubble = assistantHeader
        ? this.readBubble(db, composer.composerId, assistantHeader.bubbleId)
        : undefined;

      const prompt = userBubble?.text ?? "";
      const response = assistantBubble?.text ?? "";
      const hasResponse = response.length > 0;

      if (!prompt) {
        turnIndex++;
        continue;
      }

      // Only emit once the assistant has actually produced a final answer (stable across
      // consecutive polls - streaming text seen once could still be mid-generation) or the
      // composer settled with no response ever coming (e.g. aborted before replying). A
      // pending permission/approval prompt takes priority over both - "stable" text there
      // just means it's paused, not finished, so never treat it as ready.
      const isSettled = composer.status !== undefined && composer.status !== "in_progress";
      let ready: boolean;
      if (hasBlockingPendingAction) {
        ready = false;
      } else if (!hasResponse && isSettled) {
        ready = true;
        this.settleTracker.clear(turnKey);
      } else if (hasResponse) {
        ready = this.settleTracker.isStable(turnKey, response);
      } else {
        ready = false;
      }
      if (!ready) {
        turnIndex++;
        continue;
      }

      const toolActivity = this.extractToolActivity(userBubble, assistantBubble);

      onEvent({
        provider: this.id,
        providerDisplayName: this.displayName,
        captureMethod: "editor_chat_storage_poll",
        conversationId: composer.composerId,
        turnIndex,
        prompt,
        response,
        hasResponse,
        settleReason: composer.status ?? "unknown",
        capturedAt: new Date(userHeader.createdAt),
        url: `cursor://composer/${composer.composerId}`,
        hostname: "cursor.app",
        path: `/composer/${composer.composerId}`,
        pageTitle: "Cursor Chat",
        toolActivity,
      });

      this.emittedTurnKeys.add(turnKey);
      turnIndex++;
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

  private extractToolActivity(userBubble?: Bubble, assistantBubble?: Bubble): ToolActivitySummary {
    const toolResults = assistantBubble?.toolResults ?? [];
    const relevantFiles = assistantBubble?.relevantFiles ?? userBubble?.relevantFiles ?? [];
    const newlyCreatedFiles = assistantBubble?.newlyCreatedFiles ?? [];

    return {
      filesReadCount: relevantFiles.length,
      filesEditedCount: newlyCreatedFiles.length,
      permissionPromptsCount: 0,
      toolCallsCount: toolResults.length,
    };
  }
}
