import type { ConversationVM, MessageVM, QuickPhraseVM, RealtimeEvent, ReplySuggestionVM } from './types';

interface Envelope<T> { data?: T; }

export interface MessagesApi {
  listConversations(input: { accountId: string; cursor?: string; limit?: number; refreshExternal?: boolean }): Promise<{ items: ConversationVM[]; nextCursor?: string; hasMore: boolean }>;
  listMessages(input: { accountId: string; conversationId: string; cursor?: number; beforeCursor?: string; limit?: number; refreshExternal?: boolean }): Promise<{ items: MessageVM[]; nextCursor?: number; hasMore: boolean; latestCursor: number; hasMoreHistory: boolean; historyCursor?: string }>;
  markConversationRead?(input: { accountId: string; conversationId: string }): Promise<ConversationVM>;
  setHandlingMode?(input: { accountId: string; conversationId: string; mode: 'ai' | 'human' }): Promise<ConversationVM>;
  suggestReply?(input: { accountId: string; conversationId: string }): Promise<ReplySuggestionVM>;
  getQuickPhrases?(input: { accountId: string }): Promise<{ items: QuickPhraseVM[]; version: number }>;
  saveQuickPhrases?(input: { accountId: string; expectedVersion: number; quickPhrases: QuickPhraseVM[] }): Promise<{ items: QuickPhraseVM[]; version: number }>;
  sendMessage(input: { accountId: string; conversationId: string; text: string; idempotencyKey: string }): Promise<MessageVM>;
  sendImage(input: { accountId: string; conversationId: string; file: File; idempotencyKey: string }): Promise<MessageVM>;
  openRealtime(input: { accountId: string; conversationId: string; cursor: number; onEvent: (event: RealtimeEvent) => void; onOpen?: () => void; onClose?: () => void; onError?: () => void }): { close: () => void };
}

export function createMessagesApi(input: { get: <T>(path: string) => Promise<T>; post?: <T>(path: string, body?: unknown, init?: RequestInit) => Promise<T>; patch?: <T>(path: string, body?: unknown, init?: RequestInit) => Promise<T>; baseUrl?: string }): MessagesApi {
  return {
    async listConversations(query) {
      const params = new URLSearchParams({ accountId: query.accountId, limit: String(query.limit ?? 50) });
      if (query.cursor !== undefined) params.set('cursor', String(query.cursor));
      if (query.refreshExternal !== undefined) params.set('refreshExternal', String(query.refreshExternal));
      const payload = await input.get<Envelope<{ items: ConversationVM[]; nextCursor?: string; hasMore: boolean }>>(`/api/v1/conversations?${params.toString()}`);
      return payload.data ?? { items: [], hasMore: false };
    },
    async listMessages(query) {
      const params = new URLSearchParams({ limit: String(query.limit ?? 100) });
      if (query.cursor !== undefined) params.set('cursor', String(query.cursor));
      if (query.beforeCursor !== undefined) params.set('beforeCursor', query.beforeCursor);
      if (query.refreshExternal !== undefined) params.set('refreshExternal', String(query.refreshExternal));
      const payload = await input.get<Envelope<{ items: MessageVM[]; nextCursor?: number; hasMore: boolean; latestCursor: number; hasMoreHistory: boolean; historyCursor?: string }>>(`/api/v1/conversations/${encodeURIComponent(query.conversationId)}/messages?${params.toString()}`);
      return payload.data ?? { items: [], hasMore: false, latestCursor: 0, hasMoreHistory: false };
    },
    async markConversationRead(query) {
      if (!input.post) throw new Error('messages read api unavailable');
      const payload = await input.post<Envelope<ConversationVM>>(`/api/v1/conversations/${encodeURIComponent(query.conversationId)}/read`, {});
      if (!payload.data) throw new Error('conversation read returned no data');
      return payload.data;
    },
    async setHandlingMode(query) {
      if (!input.post) throw new Error('messages handling api unavailable');
      const payload = await input.post<Envelope<ConversationVM>>(`/api/v1/conversations/${encodeURIComponent(query.conversationId)}/handling-mode`, { mode: query.mode });
      if (!payload.data) throw new Error('handling mode returned no data');
      return payload.data;
    },
    async suggestReply(query) {
      if (!input.post) throw new Error('messages suggest api unavailable');
      const payload = await input.post<Envelope<ReplySuggestionVM>>(`/api/v1/conversations/${encodeURIComponent(query.conversationId)}/suggest-reply`, {});
      if (!payload.data) throw new Error('suggest reply returned no data');
      return payload.data;
    },
    async getQuickPhrases(query) {
      const payload = await input.get<Envelope<{ quickPhrases?: QuickPhraseVM[]; configVersion?: number }>>(`/api/v1/settings/agent?accountId=${encodeURIComponent(query.accountId)}`);
      return { items: payload.data?.quickPhrases ?? [], version: payload.data?.configVersion ?? 0 };
    },
    async saveQuickPhrases(query) {
      if (!input.patch) throw new Error('messages settings api unavailable');
      const idempotencyKey = globalThis.crypto?.randomUUID?.() ?? `qp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const payload = await input.patch<Envelope<{ quickPhrases?: QuickPhraseVM[]; configVersion?: number }>>('/api/v1/settings/agent', { accountId: query.accountId, expectedVersion: query.expectedVersion, quickPhrases: query.quickPhrases }, { headers: { 'Idempotency-Key': idempotencyKey } });
      if (!payload.data) throw new Error('quick phrases save returned no data');
      return { items: payload.data.quickPhrases ?? [], version: payload.data.configVersion ?? 0 };
    },
    async sendMessage(query) {
      if (!input.post) throw new Error('messages send api unavailable');
      const payload = await input.post<Envelope<MessageVM>>(`/api/v1/conversations/${encodeURIComponent(query.conversationId)}/messages`, { text: query.text }, { headers: { 'Idempotency-Key': query.idempotencyKey } });
      if (!payload.data) throw new Error('message send returned no data');
      return payload.data;
    },
    async sendImage(query) {
      if (!input.post) throw new Error('messages send api unavailable');
      const form = new FormData();
      form.set('image', query.file);
      const payload = await input.post<Envelope<MessageVM>>(`/api/v1/conversations/${encodeURIComponent(query.conversationId)}/images`, form, { headers: { 'Idempotency-Key': query.idempotencyKey } });
      if (!payload.data) throw new Error('image send returned no data');
      return payload.data;
    },
    openRealtime(query) {
      const socket = new WebSocket(toWebSocketUrl(input.baseUrl, `/api/v1/conversations/${encodeURIComponent(query.conversationId)}/events?cursor=${encodeURIComponent(String(query.cursor))}`));
      socket.addEventListener('open', () => query.onOpen?.());
      socket.addEventListener('message', (event) => {
        try {
          const parsed: unknown = JSON.parse(String(event.data));
          // The API currently sends the event directly. Accept the common
          // `{ event: ... }` envelope as well so a reverse proxy or realtime
          // bridge cannot silently turn live messages into no-ops.
          const candidate = isRecord(parsed) && isRecord(parsed.event) ? parsed.event : parsed;
          if (!isRealtimeEvent(candidate)) { query.onError?.(); return; }
          query.onEvent(candidate);
        } catch { query.onError?.(); }
      });
      socket.addEventListener('error', () => query.onError?.());
      socket.addEventListener('close', () => query.onClose?.());
      return { close: () => socket.close() };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isRealtimeEvent(value: unknown): value is RealtimeEvent {
  if (!isRecord(value)) return false;
  return typeof value.eventId === 'string'
    && typeof value.conversationId === 'string'
    && typeof value.accountId === 'string'
    && Number.isFinite(value.cursor)
    && typeof value.type === 'string'
    && typeof value.payload === 'object'
    && value.payload !== null;
}

function toWebSocketUrl(baseUrl: string | undefined, path: string): string {
  const resolved = baseUrl || (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8080');
  const url = new URL(path, resolved);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}
