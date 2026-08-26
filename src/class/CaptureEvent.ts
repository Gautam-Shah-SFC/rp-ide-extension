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
}
