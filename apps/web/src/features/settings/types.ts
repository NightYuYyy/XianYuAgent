export type CredentialStatus = 'active' | 'disabled' | 'rotating' | 'revoked';

export interface CredentialRefVM {
  id: string;
  accountId: string;
  kind: 'api_key';
  purpose: 'model_client';
  label?: string;
  status: CredentialStatus;
  version: number;
  provider: string;
  alias: string;
  fingerprint: string;
  metadata: Record<string, string>;
  lastRotatedAt?: string;
  createdAt: string;
  updatedAt: string;
  canReveal: false;
}

export interface CredentialListVM {
  accountId: string;
  items: CredentialRefVM[];
}

export type SettingsLoadPhase = 'idle' | 'loading' | 'empty' | 'success' | 'error' | 'submitting' | 'saved';

export interface SettingsState {
  phase: SettingsLoadPhase;
  data: CredentialListVM | null;
  error: string | null;
  lastAction?: string;
}

export type AutoReplyAgentSendMode = 'simulate' | 'live';

export interface AutoReplyMessageFilterVM {
  id: string;
  keyword: string;
  matchMode: 'contains' | 'exact' | 'regex';
  skipReply: boolean;
  skipNotify: boolean;
  enabled: boolean;
}

export interface AutoReplyBlacklistEntryVM {
  id: string;
  buyerRef: string;
  buyerName?: string;
  itemRef?: string;
  reason?: string;
  enabled: boolean;
}

export interface AutoReplyPolicyVM {
  messageFilters: AutoReplyMessageFilterVM[];
  blacklist: AutoReplyBlacklistEntryVM[];
  defaultReply: { enabled: boolean; content: string; replyOnce: boolean };
  autoRate: { enabled: boolean; content: string };
}

export interface AutoReplyKeywordRuleVM {
  id: string;
  keywords: string[];
  reply: string;
  matchMode: 'contains' | 'exact' | 'regex';
  productRef?: string;
  enabled: boolean;
}

export interface AutoReplyAgentConfigVM {
  enabled: boolean;
  systemPrompt: string;
  userPromptTemplate: string;
  maxLoops: number;
  maxToolCalls: number;
  toolTimeoutSeconds: number;
  totalTimeoutSeconds: number;
  maxHistory: number;
  maxReplyLength: number;
  replySegmentDelaySeconds: number;
  /** Legacy response field retained for backward compatibility; the UI no longer edits it. */
  debounceMs?: number;
  sendDelaySeconds: number;
  sendMode: AutoReplyAgentSendMode;
  keywordRules?: AutoReplyKeywordRuleVM[];
  replyPolicy?: AutoReplyPolicyVM;
  quickPhrases?: ChatQuickPhraseVM[];
  accountId: string;
  updatedByAdminId?: string;
  configVersion: number;
  configDigest: string;
  createdAt: string;
  updatedAt: string;
}

export interface AutoReplyAgentSettingsState {
  phase: SettingsLoadPhase;
  data: AutoReplyAgentConfigVM | null;
  error: string | null;
  lastAction?: string;
}

export type OpenAIConfigRole = 'primary' | 'backup';
export type OpenAIWireApi = 'responses' | 'chat';
export type OpenAIConnectivityState = 'unknown' | 'passed' | 'failed';

export interface OpenAIConfigVM {
  id?: string;
  accountId: string;
  role: OpenAIConfigRole;
  provider: string;
  alias: string;
  label?: string;
  baseUrl: string;
  model: string;
  reasoningEffort?: string;
  wireApi: OpenAIWireApi;
  timeoutMs: number;
  probeStrategy?: 'models' | 'completion' | 'health_url' | 'none';
  probeUrl?: string;
  probeModel?: string;
  probeTimeoutMs?: number;
  status: CredentialStatus;
  version: number;
  fingerprint?: string;
  apiKeyConfigured: boolean;
  apiKeyHint?: string;
  lastConnectivity?: OpenAIConnectivityState;
  lastConnectivityAt?: string;
  createdAt?: string;
  updatedAt?: string;
  canReveal: false;
}

export type ModelProviderCircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export type OpenAIRoutingMode = 'auto' | 'manual_primary' | 'manual_backup';

export interface OpenAIProviderStateVM {
  role: OpenAIConfigRole;
  state: ModelProviderCircuitState;
  failureCount: number;
  cooldownUntil?: string;
  nextProbeAt?: string;
  generation: number;
  lastTransitionReason?: string;
}

export interface OpenAIProviderRefVM { role: OpenAIConfigRole; id?: string; provider: string; model: string; }

export interface OpenAIRuntimeVM {
  feature_enabled?: boolean;
  mode: OpenAIRoutingMode;
  preferred_provider: OpenAIProviderRefVM | null;
  effective_provider: OpenAIProviderRefVM | null;
  last_successful_provider: OpenAIProviderRefVM | null;
  last_served_at?: string;
  observed_at: string;
  provider_states: Partial<Record<OpenAIConfigRole, OpenAIProviderStateVM>>;
  cooldown_until?: string;
  next_probe_at?: string;
  last_transition_reason?: string;
  config_generation: number;
  routing_version: number;
  server_time: string;
}

export interface OpenAIConfigListVM {
  accountId: string;
  items: OpenAIConfigVM[];
  runtime?: OpenAIRuntimeVM;
}

export interface OpenAIModelsState {
  phase: 'idle' | 'loading' | 'success' | 'empty' | 'error';
  items: string[];
  error: string | null;
}

export interface OpenAISettingsState {
  phase: SettingsLoadPhase;
  data: OpenAIConfigListVM | null;
  error: string | null;
  lastAction?: string;
}

export interface ChatQuickPhraseVM {
  id: string;
  label: string;
  content: string;
}
