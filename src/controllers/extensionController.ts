import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Provider } from "../class/Provider";
import { CaptureController } from "./captureController";
import { CursorChatProvider } from "../services/cursorChatService";
import { VscodeChatProvider } from "../services/vscodeChatService";
import { ClaudeCodeProvider } from "../services/claudeCodeService";
import { CodexProvider } from "../services/codexService";
import { AntigravityProvider } from "../services/antigravityService";
import * as authService from "../services/authService";
import * as commandRoutes from "../routes/commandRoutes";
import * as eventRoutes from "../routes/eventRoutes";
import { logger, initializeAuditLog } from "../utils/logger";
import { sharedRetroperDataDir } from "../utils/pathUtils";

let captureController: CaptureController | undefined;
let providers: Provider[] = [];
let statusBarItem: vscode.StatusBarItem | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
  fs.mkdirSync(sharedRetroperDataDir(), { recursive: true });

  // Same folder as .env, so it's easy to find without digging through VS Code's internal
  // per-window log directories - see README/Installation_Guide.
  const auditLogPath = path.join(context.extensionUri.fsPath, "audit_log.txt");
  initializeAuditLog(auditLogPath);
  logger.info(`=== Retroper activating (version ${context.extension.packageJSON.version}) ===`);

  authService.initialize(context);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(statusBarItem);
  await refreshStatusBar();

  captureController = new CaptureController(context);
  await captureController.initialize();

  const cursorStatePath = path.join(context.globalStorageUri.fsPath, "retroper-cursor-state.json");
  // Antigravity's own storage is already host-specific and IDE-only (never CLI - see
  // antigravityService.ts), same architectural shape as Cursor, so it stays on globalStorageUri
  // too - not sharedRetroperDataDir(), which is reserved for genuinely IDE-agnostic tools.
  const antigravityStatePath = path.join(context.globalStorageUri.fsPath, "retroper-antigravity-state.json");
  // Claude Code and Codex read the SAME real transcript files regardless of which IDE is hosting
  // this extension, so their dedup-state lives in the one folder every host shares - not under
  // context.globalStorageUri, which is a separate folder per host and was the whole reason the
  // same real turn could get captured and uploaded once per open IDE. Cursor's own provider stays
  // on globalStorageUri - it's already gated to only run inside actual Cursor, so there's no
  // cross-host risk to fix there.
  const claudeCodeStatePath = path.join(sharedRetroperDataDir(), "retroper-claude-code-state.json");
  const codexStatePath = path.join(sharedRetroperDataDir(), "retroper-codex-state.json");
  providers = [
    new CursorChatProvider(cursorStatePath),
    new VscodeChatProvider(context),
    new ClaudeCodeProvider(claudeCodeStatePath),
    new CodexProvider(codexStatePath),
    new AntigravityProvider(antigravityStatePath),
  ];

  commandRoutes.register(context, captureController, refreshStatusBar, auditLogPath);
  await eventRoutes.wireProviders(providers, captureController);

  logger.info(`Retroper activated - audit log at ${auditLogPath}`);

  if (!(await authService.isLoggedIn())) {
    vscode.window.showInformationMessage("Retroper: log in to start uploading captured AI usage.", "Log In").then((choice) => {
      if (choice === "Log In") {
        vscode.commands.executeCommand("retroper.login");
      }
    });
  }
}

export async function deactivate(): Promise<void> {
  logger.info("=== Retroper deactivating ===");
  await eventRoutes.stopProviders(providers);
  captureController?.dispose();
  logger.info("Retroper deactivated");
}

async function refreshStatusBar(): Promise<void> {
  if (!statusBarItem) return;
  const loggedIn = await authService.isLoggedIn();

  if (loggedIn) {
    const user = authService.getCachedUser();
    statusBarItem.text = `$(account) Retroper: ${user?.email ?? "Logged in"}`;
    statusBarItem.tooltip = "Click to log out of Retroper";
    statusBarItem.command = "retroper.logout";
  } else {
    statusBarItem.text = "$(account) Retroper: Not logged in";
    statusBarItem.tooltip = "Click to log in to Retroper";
    statusBarItem.command = "retroper.login";
  }
  statusBarItem.show();
}
