import * as vscode from "vscode";
import * as fs from "fs";

let channel: vscode.OutputChannel | undefined;
let auditLogPath: string | undefined;

function getChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("Retroper");
  }
  return channel;
}

/** Mirrors every log line to a plaintext file (next to .env, so it's easy to find without
 * digging through VS Code's per-window Output logs, which don't survive being inspected after
 * the fact across restarts). Call once at activation. */
export function initializeAuditLog(filePath: string): void {
  auditLogPath = filePath;
}

function line(level: string, message: string): string {
  return `[${new Date().toISOString()}] [${level}] ${message}`;
}

function write(text: string): void {
  getChannel().appendLine(text);
  if (auditLogPath) {
    try {
      fs.appendFileSync(auditLogPath, text + "\n");
    } catch {
      // best-effort - a logging failure should never break capture/upload
    }
  }
}

export const logger = {
  info(message: string): void {
    write(line("INFO", message));
  },
  warn(message: string): void {
    write(line("WARN", message));
  },
  error(message: string, err?: unknown): void {
    const suffix = err instanceof Error ? ` ${err.message}\n${err.stack ?? ""}` : err ? ` ${String(err)}` : "";
    write(line("ERROR", `${message}${suffix}`));
  },
};
