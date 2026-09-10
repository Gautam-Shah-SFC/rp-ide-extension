export interface ProviderMeta {
  id: string;
  displayName: string;
  /** true = adapter is implemented and wired up; false = planned/stub for now */
  enabled: boolean;
}

export const PROVIDERS: ProviderMeta[] = [
  { id: "cursor", displayName: "Cursor", enabled: true },
  { id: "vscode_chat", displayName: "VS Code Chat (Copilot)", enabled: true },
  // IMPLEMENTED 2026-09-09 - see antigravityService.ts. Antigravity keeps IDE and standalone-CLI
  // usage in separate directory trees on disk (~/.gemini/antigravity-ide vs antigravity-cli), so
  // the provider only ever reads the -ide tree - a structural CLI exclusion, no field-based filter
  // needed. Host-gated via isRunningInsideAntigravity() (vscode.env.appName), same shape as
  // Cursor's isRunningInsideCursor() - not Claude Code/Codex's shared-state fix, since this data is
  // host-specific like Cursor's, not IDE-agnostic.
  { id: "antigravity", displayName: "Antigravity", enabled: true },
  { id: "claude_code", displayName: "Claude Code", enabled: true },
  { id: "codex", displayName: "Codex CLI", enabled: true },
];
