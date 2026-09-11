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

/** The device client certificate the mTLS gateway resolved via GET /whoami, flattened onto
 * every record so an endpoint agent tailing retroper-endpoint.jsonl can attribute each captured
 * turn to a specific device cert (and forward it to S3) without a separate lookup. `authenticated`
 * false / null fields mean the gateway had not confirmed a certificate when this turn was
 * captured. */
export interface CertificateIdentity {
  fingerprint: string | null;
  serial: string | null;
  subject: string | null;
  issuer: string | null;
  authenticated: boolean;
  verified_at: string | null;
}

export interface CaptureDetails {
  settle_reason: string;
  has_response: boolean;
  files_read_count?: number;
  files_edited_count?: number;
  permission_prompts_count?: number;
  tool_calls_count?: number;
  context_tokens_used?: number;
  context_token_limit?: number;
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
  certificate_identity: CertificateIdentity;
  capture_method: string;
  capture_details: CaptureDetails;
  poc_notice_visible: boolean;
}

export interface UploadPayload {
  records: InteractionRecord[];
  source_type: "IDE_Extension";
}
