import * as vscode from "vscode";
import * as extensionController from "./controllers/extensionController";

export function activate(context: vscode.ExtensionContext): Promise<void> {
  return extensionController.activate(context);
}

export function deactivate(): Promise<void> {
  return extensionController.deactivate();
}
