import * as vscode from "vscode";
import { CaptureController } from "../controllers/captureController";
import { CaptureEvent } from "../class/CaptureEvent";
import * as authService from "../services/authService";
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

    vscode.commands.registerCommand("retroper.showStatus", async () => {
      const pending = captureController.queueLength();
      const loggedIn = await authService.isLoggedIn();
      const user = authService.getCachedUser();
      const authLine = loggedIn ? `Logged in as ${user?.email ?? "unknown"}.` : "Not logged in.";
      vscode.window.showInformationMessage(
        `Retroper: ${authLine} ${pending} record(s) queued for upload at ${captureController.queueFile()}. ` +
          `Durable endpoint log (never pruned): ${captureController.endpointFile()}.`
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
        vscode.window.showInformationMessage(`Retroper: test record sent (${sent} uploaded).`);
      } catch (err) {
        logger.error("retroper.sendTestRecord failed", err);
        vscode.window.showErrorMessage(`Retroper: test record queued but upload failed - ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    vscode.commands.registerCommand("retroper.login", async () => {
      const email = await vscode.window.showInputBox({
        title: "Retroper Login",
        prompt: "Email",
        placeHolder: "you@company.com",
        ignoreFocusOut: true,
        validateInput: (value) => (value.includes("@") ? undefined : "Enter a valid email address"),
      });
      if (!email) return;

      const password = await vscode.window.showInputBox({
        title: "Retroper Login",
        prompt: "Password",
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => (value.length > 0 ? undefined : "Password can't be empty"),
      });
      if (!password) return;

      try {
        const user = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Retroper: logging in..." },
          () => authService.login(email, password)
        );
        await refreshStatusBar();
        vscode.window.showInformationMessage(`Retroper: logged in as ${user.email}.`);
      } catch (err) {
        logger.error("retroper.login failed", err);
        vscode.window.showErrorMessage(`Retroper: login failed - ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    vscode.commands.registerCommand("retroper.logout", async () => {
      const choice = await vscode.window.showWarningMessage(
        "Log out of Retroper? Capture keeps queuing locally but stops uploading until you log in again.",
        { modal: true },
        "Log Out"
      );
      if (choice !== "Log Out") return;

      try {
        await authService.logout();
        await refreshStatusBar();
        vscode.window.showInformationMessage("Retroper: logged out.");
      } catch (err) {
        logger.error("retroper.logout failed", err);
        vscode.window.showErrorMessage(`Retroper: logout failed - ${err instanceof Error ? err.message : String(err)}`);
      }
    })
  );
}
