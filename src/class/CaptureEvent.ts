export interface ToolActivitySummary {
  filesReadCount: number;
  filesEditedCount: number;
  permissionPromptsCount: number;
  toolCallsCount: number;
}

/** Raw, provider-specific turn before it is normalized into an InteractionRecord. */
export interface CaptureEvent {
  provider: string;
  providerDisplayName: string;
  captureMethod: string;
  conversationId: string;
  turnIndex: number;
  prompt: string;
  response: string;
  hasResponse: boolean;
  settleReason: string;
  capturedAt: Date;
  url: string;
  hostname: string;
  path: string;
  pageTitle: string;
  toolActivity: ToolActivitySummary;
  /** How much of the model's context window this conversation had used, if the provider exposes
   * it (Cursor does, per-composer). Not a token-limit/truncation signal on its own - just useful
   * supporting context for a turn that never got a normal completion signal and had to be given
   * up on (see settleReason for that case). */
  contextTokensUsed?: number;
  contextTokenLimit?: number;
}
