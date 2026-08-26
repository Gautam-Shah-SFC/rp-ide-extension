import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Provider } from "../class/Provider";
import { CaptureController } from "./captureController";
import { CursorChatProvider } from "../services/cursorChatService";
import { VscodeChatProvider } from "../services/vscodeChatService";
import { ClaudeCodeProvider } from "../services/claudeCodeService";
import { CodexProvider } from "../services/codexService";
import * as authService from "../services/authService";
import * as commandRoutes from "../routes/commandRoutes";
import * as eventRoutes from "../routes/eventRoutes";
import { logger, initializeAuditLog } from "../utils/logger";

let captureController: CaptureController | undefined;
let providers: Provider[] = [];
let statusBarItem: vscode.StatusBarItem | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });

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
  const claudeCodeStatePath = path.join(context.globalStorageUri.fsPath, "retroper-claude-code-state.json");
  const codexStatePath = path.join(context.globalStorageUri.fsPath, "retroper-codex-state.json");
  providers = [
    new CursorChatProvider(cursorStatePath),
    new VscodeChatProvider(context),
    new ClaudeCodeProvider(claudeCodeStatePath),
    new CodexProvider(codexStatePath),
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
