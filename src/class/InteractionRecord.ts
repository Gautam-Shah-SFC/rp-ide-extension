export interface BrowserProfileIdentity {
  email: string | null;
  id: string | null;
  source: string;
  status: "ok" | "unavailable" | "error";
}

export interface AppAccountIdentity {
  visible_email_candidates: string[];
  source: string;
  confidence: "candidate" | "confirmed" | "unknown";
}

export interface ContentStorage {
  mode: "full_text" | "hash_only";
  location: string;
  boundary: string;
}

export interface CaptureDetails {
  settle_reason: string;
  has_response: boolean;
  files_read_count?: number;
  files_edited_count?: number;
  permission_prompts_count?: number;
  tool_calls_count?: number;
}

/** Matches backend schema retroper.ai_interaction.v0.2 */
export interface InteractionRecord {
  id: string;
  received_at: string;
  extension_version: string;
  browser_profile_identity: BrowserProfileIdentity;
  schema_version: string;
  source: "chrome_extension_content_script" | "ide_extension";
  provider: string;
  provider_display_name: string;
  event_type: string;
  role: "turn";
  captured_at: string;
  url: string;
  hostname: string;
  path: string;
  page_title: string;
  conversation_id: string;
  turn_index: number;
  prompt: string;
  response: string;
  prompt_length: number;
  response_length: number;
  prompt_hash_sha256: string;
  response_hash_sha256: string;
  content_hash_sha256: string;
  text_length: number;
  content_storage: ContentStorage;
  app_account_identity: AppAccountIdentity;
  capture_method: string;
  capture_details: CaptureDetails;
  poc_notice_visible: boolean;
}

export interface UploadPayload {
  records: InteractionRecord[];
  source_type: "IDE_Extension";
}
