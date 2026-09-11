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
import * as certIdentityService from "../services/certIdentityService";
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

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(statusBarItem);
  await refreshStatusBar();

  // When the device's certificate store holds more than one Retroper client certificate, let the
  // user pick which one to present to the gateway (the choice is remembered).
  certIdentityService.setCertChooser(async (candidates) => {
    const pick = await vscode.window.showQuickPick(
      candidates.map((c) => ({
        label: c.subject || c.thumbprint,
        description: `${c.storeLocation}\\My · expires ${c.notAfter}`,
        detail: `${c.issuer}  ·  ${c.thumbprint}`,
        thumbprint: c.thumbprint,
      })),
      { title: "Retroper: choose the device certificate", placeHolder: "Multiple matching certificates found - pick one", ignoreFocusOut: true }
    );
    return pick?.thumbprint;
  });

  // Resolve this device's identity from the mTLS gateway (GET /whoami) once, then reuse it for ~a
  // day (persisted to disk). The result is stamped onto every captured record. Not awaited:
  // activation must not block on a network round-trip, and capture runs regardless of the outcome.
  certIdentityService
    .start()
    .then((identity) => {
      logger.info(`Retroper: device certificate check - ${certIdentityService.describe(identity)}`);
      void refreshStatusBar();
      if (!identity.authenticated) {
        vscode.window
          .showInformationMessage(
            `Retroper: ${certIdentityService.describe(identity)}. Capture runs locally regardless; records are tagged with the device certificate once the gateway confirms one.`,
            "Check Again"
          )
          .then((choice) => {
            if (choice === "Check Again") {
              vscode.commands.executeCommand("retroper.checkCertificate");
            }
          });
      }
    })
    .catch((err) => logger.error("Retroper: device certificate check threw", err));

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
}

export async function deactivate(): Promise<void> {
  logger.info("=== Retroper deactivating ===");
  certIdentityService.stop();
  await eventRoutes.stopProviders(providers);
  captureController?.dispose();
  logger.info("Retroper deactivated");
}

async function refreshStatusBar(): Promise<void> {
  if (!statusBarItem) return;
  const identity = certIdentityService.getCachedIdentity();

  if (identity.authenticated) {
    statusBarItem.text = `$(shield) Retroper: ${identity.subject ?? identity.fingerprint ?? "certificate verified"}`;
    statusBarItem.tooltip = `Device certificate verified by the gateway (fingerprint ${identity.fingerprint}, valid until ${identity.validUntil}). Click to re-check.`;
  } else {
    statusBarItem.text = "$(shield) Retroper: no device certificate";
    statusBarItem.tooltip = `${certIdentityService.describe(identity)}. Click to re-check.`;
  }
  statusBarItem.command = "retroper.checkCertificate";
  statusBarItem.show();
}
