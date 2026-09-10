import * as os from "os";
import * as path from "path";

export function appDataRoaming(): string {
  if (process.platform === "win32") {
    return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

/** e.g. "Cursor", "Code", "Code - Insiders" */
export function ideUserDataDir(ideFolderName: string): string {
  return path.join(appDataRoaming(), ideFolderName, "User");
}

/** One location shared by every IDE host this extension runs in, unlike context.globalStorageUri
 * (which is a separate folder per host - Code vs Cursor vs any other fork). Needed specifically
 * for providers whose underlying data is genuinely IDE-agnostic (Claude Code, Codex CLI - their
 * transcripts live at a single fixed path regardless of which editor is open) - CONFIRMED via
 * real evidence on 2026-09-07 that keeping their dedup-state per-host causes the exact same real
 * turn to be captured and uploaded once by each host running simultaneously, since neither knows
 * the other already saw it. Not used for Cursor's or VS Code Chat's own providers - their
 * underlying data is already scoped to one specific host, so there's no cross-host risk to fix. */
export function sharedRetroperDataDir(): string {
  return path.join(appDataRoaming(), "Retroper");
}
