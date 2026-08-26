import * as fs from "fs";

const DEFAULT_STALE_MS = 60_000;

/**
 * Cross-process mutex via exclusive file creation (fs 'wx' flag - meant to be atomic at the OS
 * level, so two processes racing to create the same file should never both succeed). Needed
 * because multiple IDE windows each run their own independent copy of this extension, all
 * reading/writing the SAME shared global-storage files (dedup state, upload queue) - without
 * this, each window's in-memory view goes stale relative to what other windows already did.
 *
 * CONFIRMED on 2026-08-26 via real duplicate captures in production logs (two processes both
 * logging a successful lock + capture for the same turn within 1ms of each other) that 'wx'
 * alone is not reliably atomic on at least one real Windows machine in this fleet - endpoint
 * security software (e.g. CrowdStrike Falcon, confirmed installed on that machine via Codex
 * CLI's own diagnostics) is a known cause of exactly this by intercepting file I/O. So this now
 * writes a unique token and re-reads the file to verify it still holds - a second, independent
 * check that doesn't depend on the OS's create-exclusive being airtight. Still not a mathematical
 * guarantee (nothing built on plain file APIs against an intercepting agent can be), but closes
 * the specific race that was observed.
 *
 * Returns a token string if the lock was acquired (pass it to releaseLock when done), or
 * undefined if another process currently holds it (caller should just skip this cycle).
 */
export function tryAcquireLock(lockPath: string, staleMs: number = DEFAULT_STALE_MS): string | undefined {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeSync(fd, `${Date.now()}:${token}`);
    fs.closeSync(fd);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
    // Someone holds the lock - but if they crashed/were killed while holding it, the file
    // would otherwise block every future poll forever. Treat an old-enough lock as abandoned.
    try {
      const heldSince = Number(fs.readFileSync(lockPath, "utf8").split(":")[0]);
      if (Date.now() - heldSince > staleMs) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          return undefined;
        }
        return tryAcquireLock(lockPath, staleMs);
      }
    } catch {
      // Lock file vanished or was unreadable mid-check (another process's release/write) -
      // just report "not acquired" for this attempt rather than risk a double-delete race.
    }
    return undefined;
  }

  // Verify we actually won: re-read immediately and check our own token is still there. If
  // 'wx' let a second writer through around the same time, this catches it - whichever of the
  // two processes reads back a token that isn't its own backs off instead of proceeding.
  try {
    const current = fs.readFileSync(lockPath, "utf8");
    if (!current.endsWith(`:${token}`)) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  return token;
}

export function releaseLock(lockPath: string, token: string): void {
  try {
    const current = fs.readFileSync(lockPath, "utf8");
    if (!current.endsWith(`:${token}`)) {
      // Someone else's lock now (ours was likely reclaimed as stale after we ran unusually
      // long) - do not delete a lock we no longer own.
      return;
    }
    fs.unlinkSync(lockPath);
  } catch {
    // already gone - fine
  }
}
