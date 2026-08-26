import * as fs from "fs";
import { logger } from "../utils/logger";

/** Small persisted string-set, used so capture adapters remember what they already
 * emitted across restarts (an in-memory-only Set would re-emit/re-upload every reload). */
export function loadKeySet(statePath: string): Set<string> {
  if (!fs.existsSync(statePath)) {
    return new Set();
  }
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const keys: string[] = JSON.parse(raw);
    return new Set(keys);
  } catch (err) {
    logger.warn(`stateService: failed to read ${statePath}, starting fresh: ${String(err)}`);
    return new Set();
  }
}

export function saveKeySet(statePath: string, keys: Set<string>): void {
  fs.writeFileSync(statePath, JSON.stringify(Array.from(keys)));
}
