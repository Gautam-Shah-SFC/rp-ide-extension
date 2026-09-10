import * as path from "path";
import * as vscode from "vscode";
import { CaptureEvent } from "../class/CaptureEvent";
import { BrowserProfileIdentity, AppAccountIdentity } from "../class/InteractionRecord";
import { normalize } from "../services/normalizerService";
import * as bufferService from "../services/bufferService";
import { uploadBatch } from "../services/uploadService";
import { resolveIdentity } from "../services/identityService";
import { BUFFER_FILE_NAME, ENDPOINT_FILE_NAME, UPLOAD_BATCH_SIZE, UPLOAD_INTERVAL_MS } from "../config/constants";
import { logger } from "../utils/logger";
import { tryAcquireLock, releaseLock } from "../utils/fileLock";
import { sharedRetroperDataDir } from "../utils/pathUtils";

export class CaptureController {
  private queueFilePath: string;
  private endpointFilePath: string;
  private uploadLockPath: string;
  private identity: { browserProfileIdentity: BrowserProfileIdentity; appAccountIdentity: AppAccountIdentity } | undefined;
  private uploadTimer: NodeJS.Timeout | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    // CHANGED 2026-09-09, per explicit request: every provider (Cursor, VS Code Chat, Antigravity,
    // Claude Code, Codex) now appends to and flushes ONE single queue file in the shared,
    // host-agnostic location - not context.globalStorageUri, which was a separate file per IDE
    // host - so a future external "endpoint agent" has exactly one well-known path to read/tail,
    // regardless of which IDE(s) are running. The existing lock in flush() already guarded against
    // multiple windows of the SAME host racing on this file; pointing every host at the same path
    // means that same lock now also correctly guards against DIFFERENT hosts (e.g. Cursor and VS
    // Code open at once) racing on it - no change to the locking logic itself was needed.
    this.queueFilePath = path.join(sharedRetroperDataDir(), BUFFER_FILE_NAME);
    this.uploadLockPath = `${this.queueFilePath}.upload.lock`;
    // Durable append-only mirror. The queue file above is drained (lines deleted) as records are
    // uploaded to the backend, so it is not a reliable record of "everything that was captured".
    // This file keeps every captured record permanently for an external endpoint agent to read
    // and forward (e.g. to an S3 bucket) on its own schedule. Retroper only ever appends here -
    // it never reads, rewrites, or truncates it.
    this.endpointFilePath = path.join(sharedRetroperDataDir(), ENDPOINT_FILE_NAME);
  }

  async initialize(): Promise<void> {
    this.identity = await resolveIdentity();
    this.uploadTimer = setInterval(() => {
      this.flush().catch((err) => logger.error("CaptureController: scheduled flush failed", err));
    }, UPLOAD_INTERVAL_MS);
  }

  dispose(): void {
    if (this.uploadTimer) {
      clearInterval(this.uploadTimer);
    }
  }

  handleEvent(event: CaptureEvent): void {
    if (!this.identity) {
      logger.warn("CaptureController: received event before identity was resolved, dropping");
      return;
    }
    const record = normalize(
      event,
      this.context.extension.packageJSON.version,
      this.identity.browserProfileIdentity,
      this.identity.appAccountIdentity
    );
    bufferService.appendRecords(this.queueFilePath, [record]);
    bufferService.appendRecords(this.endpointFilePath, [record]);
    logger.info(`Captured turn from ${event.provider} (conversation ${event.conversationId}, turn ${event.turnIndex})`);
  }

  async flush(): Promise<number> {
    // Multiple IDE windows share this same queue file - without a lock, two windows' upload
    // timers firing close together could both read the same not-yet-removed batch and both
    // POST it to the backend, duplicating the same records there even though the local queue
    // only ever held one copy.
    // Retries with backoff can legitimately run past a minute on a slow/flaky connection, so
    // this lock tolerates staying held longer than the default before being treated as abandoned.
    const lockToken = tryAcquireLock(this.uploadLockPath, 180_000);
    if (!lockToken) {
      logger.info("CaptureController: another window is uploading this cycle, skipping");
      return 0;
    }
    try {
      const batch = bufferService.peekBatch(this.queueFilePath, UPLOAD_BATCH_SIZE);
      if (batch.length === 0) {
        return 0;
      }
      const result = await uploadBatch(batch);
      const toRemove = new Set([...result.uploadedIds, ...result.permanentlyRejectedIds]);
      if (toRemove.size > 0) {
        bufferService.removeRecords(this.queueFilePath, toRemove);
      }
      if (result.permanentlyRejectedIds.length > 0) {
        logger.warn(
          `CaptureController: ${result.permanentlyRejectedIds.length} record(s) permanently rejected by the backend and dropped from the local queue (see uploadService errors above for which ones and why).`
        );
      }
      return result.uploadedIds.length;
    } finally {
      releaseLock(this.uploadLockPath, lockToken);
    }
  }

  queueLength(): number {
    return bufferService.queueLength(this.queueFilePath);
  }

  queueFile(): string {
    return this.queueFilePath;
  }

  endpointFile(): string {
    return this.endpointFilePath;
  }
}
