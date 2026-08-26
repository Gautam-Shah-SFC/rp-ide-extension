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
