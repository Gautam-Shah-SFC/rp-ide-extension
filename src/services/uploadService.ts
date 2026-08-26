import { InteractionRecord, UploadPayload } from "../class/InteractionRecord";
import { UPLOAD_URL, UPLOAD_MAX_RETRIES, UPLOAD_RETRY_BASE_DELAY_MS, SOURCE_TYPE } from "../config/constants";
import { NonRetryableError } from "../utils/retry";
import { logger } from "../utils/logger";
import * as authService from "./authService";

export interface UploadResult {
  /** Record ids the backend confirmed it received - safe to remove from the local queue. */
  uploadedIds: string[];
  /** Record ids the backend will never accept as-is (e.g. its own DLP scan blocked one) -
   * also safe to remove from the local queue, since retrying them can't ever succeed. */
  permanentlyRejectedIds: string[];
}

interface PostOutcome {
  ok: boolean;
  status: number;
  statusText: string;
  bodyText: string;
  elapsedMs: number;
}

export async function uploadBatch(records: InteractionRecord[]): Promise<UploadResult> {
  if (records.length === 0) {
    return { uploadedIds: [], permanentlyRejectedIds: [] };
  }

  if (!UPLOAD_URL) {
    logger.warn("uploadService: RETROPER_UPLOAD_URL not set (see .env.example). Records stay queued locally until configured.");
    throw new NonRetryableError("Retroper upload not configured: missing RETROPER_UPLOAD_URL in .env");
  }

  const token = await authService.getToken();
  if (!token) {
    logger.warn("uploadService: not logged in. Records stay queued locally - run 'Retroper: Login'.");
    throw new NonRetryableError("Retroper: not logged in. Run 'Retroper: Login' to start uploading.");
  }

  return uploadIsolating(records, token);
}

/**
 * Uploads `records` as one batch. If the backend definitively rejects the whole batch (any 4xx
 * other than 401 auth or 429 rate-limit - e.g. its own DLP scan blocking a raw secret it found
 * in one record's content), retrying the identical batch can never succeed, and leaving it queued
 * would jam every record behind it forever. Instead this narrows down which individual record(s)
 * are actually at fault by splitting the batch and re-sending the halves, so everything else in
 * the batch still gets delivered and only the genuinely-bad record(s) get dropped (with a clear
 * log line explaining why). Verified against a real backend rejection on 2026-08-25.
 */
async function uploadIsolating(records: InteractionRecord[], token: string): Promise<UploadResult> {
  const outcome = await postWithRetry(records, token);

  if (outcome.ok) {
    const sizeKb = Math.round(JSON.stringify(buildPayload(records)).length / 1024);
    logger.info(`Uploaded ${records.length} record(s) (${sizeKb}KB, ${outcome.elapsedMs}ms) to ${UPLOAD_URL}`);
    return { uploadedIds: records.map((r) => r.id), permanentlyRejectedIds: [] };
  }

  if (outcome.status === 401) {
    // Token expired/invalid - clear it so we stop retrying with a known-bad token and the
    // status bar reflects "not logged in" (rather than silently failing every 30s forever).
    await authService.clearStoredToken();
    throw new NonRetryableError(
      `Retroper: session expired, please log in again. Upload failed: 401 Unauthorized (${outcome.elapsedMs}ms) ${outcome.bodyText}`
    );
  }

  if (records.length === 1) {
    const r = records[0];
    logger.error(
      `uploadService: record ${r.id} (${r.provider}, conversation ${r.conversation_id}, turn ${r.turn_index}) permanently rejected by the backend - dropping it from the local queue so it doesn't block everything behind it. ${outcome.status} ${outcome.statusText} ${outcome.bodyText}`
    );
    return { uploadedIds: [], permanentlyRejectedIds: [r.id] };
  }

  logger.warn(
    `uploadService: batch of ${records.length} record(s) rejected (${outcome.status} ${outcome.statusText}) - splitting to isolate which one(s) are at fault. ${outcome.bodyText}`
  );
  const mid = Math.floor(records.length / 2);
  const left = await uploadIsolating(records.slice(0, mid), token);
  const right = await uploadIsolating(records.slice(mid), token);
  return {
    uploadedIds: [...left.uploadedIds, ...right.uploadedIds],
    permanentlyRejectedIds: [...left.permanentlyRejectedIds, ...right.permanentlyRejectedIds],
  };
}

function buildPayload(records: InteractionRecord[]): UploadPayload {
  return { records, source_type: SOURCE_TYPE };
}

/** Retries only the genuinely-transient outcomes (network error, 5xx, 429); returns the final
 * outcome either way rather than throwing, so the caller can decide what a definitive rejection
 * means (uploadIsolating above narrows it down instead of giving up on the whole batch).
 *
 * NOTE on duplicate risk: a status:0 (network error) outcome is ambiguous - it means the client
 * never got a response, not that the backend never got the request. If the backend actually
 * received and stored the batch before the connection dropped, this retry resends the exact
 * same record `id`s again, and the backend will store a second (or third) identical copy unless
 * it deduplicates ingest by `id` (every record already carries one, unchanged across retries -
 * see InteractionRecord.id). This is believed to be the real explanation for records observed
 * reaching the backend as exact-duplicate JSON multiple times, logged explicitly below so future
 * occurrences are directly traceable instead of requiring a guess. */
async function postWithRetry(records: InteractionRecord[], token: string): Promise<PostOutcome> {
  let attempt = 0;
  for (;;) {
    const outcome = await postOnce(records, token);
    const isRetryableStatus = outcome.status === 0 || outcome.status >= 500 || outcome.status === 429;
    if (outcome.ok || !isRetryableStatus) {
      return outcome;
    }
    attempt++;
    if (attempt > UPLOAD_MAX_RETRIES) {
      return outcome;
    }
    if (outcome.status === 0) {
      logger.warn(
        `uploadService: retrying batch of ${records.length} record(s) [ids: ${records.map((r) => r.id).join(",")}] after a network-level failure (attempt ${attempt}/${UPLOAD_MAX_RETRIES}) - if that request actually reached the backend before failing client-side, this retry may create a duplicate unless the backend deduplicates ingest by record id.`
      );
    }
    const delay = UPLOAD_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

async function postOnce(records: InteractionRecord[], token: string): Promise<PostOutcome> {
  const bodyText = JSON.stringify(buildPayload(records));
  const sizeKb = Math.round(bodyText.length / 1024);
  const startedAt = Date.now();

  let response: Response;
  try {
    response = await fetch(UPLOAD_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: bodyText,
    });
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    logger.warn(`uploadService: request failed after ${elapsedMs}ms (payload ${sizeKb}KB): ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, status: 0, statusText: "network_error", bodyText: String(err), elapsedMs };
  }

  const elapsedMs = Date.now() - startedAt;
  const bodyText2 = response.ok ? "" : await response.text().catch(() => "");
  return { ok: response.ok, status: response.status, statusText: response.statusText, bodyText: bodyText2, elapsedMs };
}
