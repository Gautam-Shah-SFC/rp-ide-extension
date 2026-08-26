export interface ProviderMeta {
  id: string;
  displayName: string;
  /** true = adapter is implemented and wired up; false = planned/stub for now */
  enabled: boolean;
}

export const PROVIDERS: ProviderMeta[] = [
  { id: "cursor", displayName: "Cursor", enabled: true },
  { id: "vscode_chat", displayName: "VS Code Chat (Copilot)", enabled: true },
  { id: "antigravity", displayName: "Antigravity", enabled: false },
  { id: "claude_code", displayName: "Claude Code", enabled: true },
  { id: "codex", displayName: "Codex CLI", enabled: true },
];
