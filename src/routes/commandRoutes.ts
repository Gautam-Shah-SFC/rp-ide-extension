import * as vscode from "vscode";
import { CaptureController } from "../controllers/captureController";
import { CaptureEvent } from "../class/CaptureEvent";
import * as certIdentityService from "../services/certIdentityService";
import { logger } from "../utils/logger";

export function register(
  context: vscode.ExtensionContext,
  captureController: CaptureController,
  refreshStatusBar: () => Promise<void>,
  auditLogPath: string
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("retroper.openAuditLog", async () => {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(auditLogPath));
        await vscode.window.showTextDocument(doc);
      } catch (err) {
        vscode.window.showErrorMessage(
          `Retroper: could not open audit log at ${auditLogPath} - ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),

    vscode.commands.registerCommand("retroper.flushQueue", async () => {
      try {
        const sent = await captureController.flush();
        vscode.window.showInformationMessage(`Retroper: uploaded ${sent} record(s).`);
      } catch (err) {
        logger.error("retroper.flushQueue failed", err);
        vscode.window.showErrorMessage(`Retroper: upload failed - ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    vscode.commands.registerCommand("retroper.checkCertificate", async () => {
      const identity = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Retroper: checking device certificate..." },
        () => certIdentityService.refreshIdentity()
      );
      await refreshStatusBar();
      if (identity.authenticated) {
        vscode.window.showInformationMessage(
          `Retroper: ${certIdentityService.describe(identity)} - fingerprint ${identity.fingerprint}, valid until ${identity.validUntil}.`
        );
      } else {
        vscode.window.showWarningMessage(
          `Retroper: ${certIdentityService.describe(identity)}. Capture continues locally; records are tagged as unauthenticated until the gateway confirms a certificate.`
        );
      }
    }),

    vscode.commands.registerCommand("retroper.showStatus", async () => {
      const pending = captureController.queueLength();
      const identity = certIdentityService.getCachedIdentity();
      const certLine = identity.authenticated
        ? `Device certificate: ${identity.subject ?? identity.fingerprint} (fingerprint ${identity.fingerprint}, valid until ${identity.validUntil}).`
        : `Device certificate: ${certIdentityService.describe(identity)}.`;
      vscode.window.showInformationMessage(
        `Retroper: ${certLine} ${pending} record(s) queued for upload at ${captureController.queueFile()}. ` +
          `Durable endpoint log (never pruned, read by the endpoint agent): ${captureController.endpointFile()}.`
      );
    }),

    vscode.commands.registerCommand("retroper.sendTestRecord", async () => {
      const testEvent: CaptureEvent = {
        provider: "retroper_test",
        providerDisplayName: "Retroper Test",
        captureMethod: "manual_test_command",
        conversationId: `test-${Date.now()}`,
        turnIndex: 0,
        prompt: "This is a Retroper test prompt.",
        response: "This is a Retroper test response.",
        hasResponse: true,
        settleReason: "response_settled",
        capturedAt: new Date(),
        url: "retroper://test",
        hostname: "retroper-test",
        path: "/test",
        pageTitle: "Retroper Test",
        toolActivity: {
          filesReadCount: 0,
          filesEditedCount: 0,
          permissionPromptsCount: 0,
          toolCallsCount: 0,
        },
      };
      captureController.handleEvent(testEvent);
      try {
        const sent = await captureController.flush();
        logger.info(`retroper.sendTestRecord: flushed ${sent} record(s)`);
        vscode.window.showInformationMessage(`Retroper: test record written to the endpoint log (${sent} uploaded).`);
      } catch (err) {
        logger.error("retroper.sendTestRecord failed", err);
        vscode.window.showErrorMessage(`Retroper: test record written but upload failed - ${err instanceof Error ? err.message : String(err)}`);
      }
    })
  );
}
