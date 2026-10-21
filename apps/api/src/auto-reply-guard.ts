import type { AutoReplyGeneratedReply, AutoReplyGenerator } from './auto-reply.js';
import type { AutoReplyBlacklistEntry, AutoReplyMessageFilter, AutoReplyPolicy, Store, XianyuImMessageEventLike } from './domain.js';
import { ServiceError } from './services.js';

export const MAX_MESSAGE_FILTERS = 200;
export const MAX_BLACKLIST_ENTRIES = 2_000;
export const MAX_DEFAULT_REPLY_LENGTH = 2_000;
export const MAX_RATE_CONTENT_LENGTH = 500;
const MATCH_MODES = ['contains', 'exact', 'regex'] as const;

export const EMPTY_REPLY_POLICY: AutoReplyPolicy = {
  messageFilters: [],
  blacklist: [],
  defaultReply: { enabled: false, content: '', replyOnce: true },
  autoRate: { enabled: false, content: '好买家，交易愉快！' },
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Lenient normalisation used when reading stored JSON; never throws. */
export function sanitizeReplyPolicy(raw: unknown): AutoReplyPolicy {
  const record = asRecord(raw);
  const filters = (Array.isArray(record.messageFilters) ? record.messageFilters : []).slice(0, MAX_MESSAGE_FILTERS).map((item, index): AutoReplyMessageFilter | undefined => {
    const entry = asRecord(item);
    const keyword = text(entry.keyword, 200);
    if (!keyword) return undefined;
    const matchMode = MATCH_MODES.includes(entry.matchMode as never) ? entry.matchMode as AutoReplyMessageFilter['matchMode'] : 'contains';
    return { id: text(entry.id, 64) || `mf-${index + 1}`, keyword, matchMode, skipReply: bool(entry.skipReply, true), skipNotify: bool(entry.skipNotify, false), enabled: bool(entry.enabled, true) };
  }).filter((item): item is AutoReplyMessageFilter => Boolean(item));
  const blacklist = (Array.isArray(record.blacklist) ? record.blacklist : []).slice(0, MAX_BLACKLIST_ENTRIES).map((item, index): AutoReplyBlacklistEntry | undefined => {
    const entry = asRecord(item);
    const buyerRef = text(entry.buyerRef, 64);
    if (!buyerRef) return undefined;
    return { id: text(entry.id, 64) || `bl-${index + 1}`, buyerRef, buyerName: text(entry.buyerName, 120) || undefined, itemRef: text(entry.itemRef, 64) || undefined, reason: text(entry.reason, 500) || undefined, enabled: bool(entry.enabled, true) };
  }).filter((item): item is AutoReplyBlacklistEntry => Boolean(item));
  const defaultReply = asRecord(record.defaultReply);
  const autoRate = asRecord(record.autoRate);
  return {
    messageFilters: filters,
    blacklist,
    defaultReply: { enabled: bool(defaultReply.enabled, false), content: text(defaultReply.content, MAX_DEFAULT_REPLY_LENGTH), replyOnce: bool(defaultReply.replyOnce, true) },
    autoRate: { enabled: bool(autoRate.enabled, false), content: text(autoRate.content, MAX_RATE_CONTENT_LENGTH) || EMPTY_REPLY_POLICY.autoRate.content },
  };
}

/** Strict validation for admin writes. */
export function validateReplyPolicy(raw: unknown): AutoReplyPolicy {
  if (raw === undefined || raw === null) return EMPTY_REPLY_POLICY;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ServiceError(422, 'VALIDATION_FAILED', 'replyPolicy must be an object');
  const record = raw as Record<string, unknown>;
  const filters = record.messageFilters === undefined ? [] : record.messageFilters;
  const blacklist = record.blacklist === undefined ? [] : record.blacklist;
  if (!Array.isArray(filters)) throw new ServiceError(422, 'VALIDATION_FAILED', 'replyPolicy.messageFilters must be an array');
  if (!Array.isArray(blacklist)) throw new ServiceError(422, 'VALIDATION_FAILED', 'replyPolicy.blacklist must be an array');
  if (filters.length > MAX_MESSAGE_FILTERS) throw new ServiceError(422, 'VALIDATION_FAILED', `最多 ${MAX_MESSAGE_FILTERS} 条消息过滤规则`);
  if (blacklist.length > MAX_BLACKLIST_ENTRIES) throw new ServiceError(422, 'VALIDATION_FAILED', `最多 ${MAX_BLACKLIST_ENTRIES} 条黑名单`);
  for (const item of filters) {
    const entry = asRecord(item);
    if (!text(entry.keyword, 200)) throw new ServiceError(422, 'VALIDATION_FAILED', '消息过滤规则的关键词不能为空');
    if (entry.matchMode === 'regex') {
      try { new RegExp(String(entry.keyword), 'iu'); } catch { throw new ServiceError(422, 'VALIDATION_FAILED', `正则表达式无效：${String(entry.keyword)}`); }
    }
  }
  for (const item of blacklist) {
    if (!text(asRecord(item).buyerRef, 64)) throw new ServiceError(422, 'VALIDATION_FAILED', '黑名单的买家 ID 不能为空');
  }
  const policy = sanitizeReplyPolicy(raw);
  if (policy.defaultReply.enabled && !policy.defaultReply.content) throw new ServiceError(422, 'VALIDATION_FAILED', '启用默认回复时必须填写内容');
  if (policy.autoRate.enabled && !policy.autoRate.content) throw new ServiceError(422, 'VALIDATION_FAILED', '启用自动好评时必须填写评价内容');
  return policy;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
}
const regexCache = new Map<string, RegExp | null>();
function matchesFilter(filter: AutoReplyMessageFilter, body: string): boolean {
  if (filter.matchMode === 'regex') {
    let compiled = regexCache.get(filter.keyword);
    if (compiled === undefined) {
      try { compiled = new RegExp(filter.keyword, 'iu'); } catch { compiled = null; }
      regexCache.set(filter.keyword, compiled);
    }
    return compiled ? compiled.test(body) : false;
  }
  const haystack = normalize(body);
  const needle = normalize(filter.keyword);
  if (!needle) return false;
  return filter.matchMode === 'exact' ? haystack === needle : haystack.includes(needle);
}

export interface InboundPolicyVerdict {
  /** 'allow' lets the agent run; the other values skip the reply. */
  action: 'allow' | 'blacklisted' | 'filtered';
  /** Suppress human-handoff notifications for this message. */
  skipNotify: boolean;
  matchedId?: string;
  reason?: string;
}

export function evaluateInboundPolicy(policy: AutoReplyPolicy | undefined, input: { buyerRef?: string; itemRef?: string; text?: string }): InboundPolicyVerdict {
  if (!policy) return { action: 'allow', skipNotify: false };
  const buyerRef = (input.buyerRef ?? '').trim();
  if (buyerRef) {
    const hit = policy.blacklist.find((entry) => entry.enabled && entry.buyerRef === buyerRef && (!entry.itemRef || entry.itemRef === (input.itemRef ?? '')));
    if (hit) return { action: 'blacklisted', skipNotify: true, matchedId: hit.id, reason: hit.reason };
  }
  const body = input.text ?? '';
  let skipNotify = false;
  let skipReply: AutoReplyMessageFilter | undefined;
  if (body) {
    for (const filter of policy.messageFilters) {
      if (!filter.enabled || !matchesFilter(filter, body)) continue;
      if (filter.skipNotify) skipNotify = true;
      if (filter.skipReply && !skipReply) skipReply = filter;
    }
  }
  if (skipReply) return { action: 'filtered', skipNotify, matchedId: skipReply.id, reason: `filter:${skipReply.keyword}` };
  return { action: 'allow', skipNotify };
}

export type ReplyPolicyLoader = (adminId: string | undefined, accountId: string) => Promise<AutoReplyPolicy | undefined>;

type GenerateInput = Parameters<AutoReplyGenerator['generate']>[0];

/**
 * Sends the configured default reply when the wrapped generator has nothing
 * to say (no generator, explicit skip, or a failure). With `replyOnce` the
 * default text is sent at most once per conversation.
 */
export class DefaultReplyFallbackGenerator implements AutoReplyGenerator {
  constructor(private readonly loadPolicy: ReplyPolicyLoader, private readonly inner?: AutoReplyGenerator, private readonly logger: Pick<Console, 'info' | 'warn'> = console) {}

  get supportsStructuredDecision(): boolean | undefined { return this.inner?.supportsStructuredDecision; }
  get supportsMultimodal(): boolean | undefined { return this.inner?.supportsMultimodal; }

  async generate(input: GenerateInput): Promise<string | AutoReplyGeneratedReply | undefined> {
    const accountId = input.context.conversation.accountId;
    const policy = await this.loadPolicy(input.adminId, accountId).catch(() => undefined);
    const fallback = policy?.defaultReply.enabled && policy.defaultReply.content ? policy.defaultReply : undefined;
    let result: string | AutoReplyGeneratedReply | undefined;
    try {
      result = this.inner ? await this.inner.generate(input) : undefined;
    } catch (error) {
      if (!fallback) throw error;
      this.logger.warn(JSON.stringify({ component: 'auto-reply-guard', event: 'default_reply_after_failure', accountId, conversationId: input.context.conversation.id, reason: error instanceof Error ? error.message : String(error) }));
      return this.defaultReply(input, fallback);
    }
    const decision = typeof result === 'object' && result ? result.decision : undefined;
    const empty = result === undefined || (typeof result === 'string' ? !result.trim() : !result.text?.trim());
    if (fallback && (decision === 'skip' || empty)) {
      const replaced = this.defaultReply(input, fallback);
      if (replaced) return replaced;
    }
    return result;
  }

  async segmentReply(input: { reply: string; signal?: AbortSignal; deadlineAt?: number }): Promise<string[] | undefined> {
    return this.inner?.segmentReply ? this.inner.segmentReply(input) : undefined;
  }

  private defaultReply(input: GenerateInput, fallback: AutoReplyPolicy['defaultReply']): AutoReplyGeneratedReply | undefined {
    if (fallback.replyOnce) {
      const alreadySent = input.context.recentMessages.some((message) => message.direction === 'outbound' && (message.bodyText ?? '').trim() === fallback.content);
      if (alreadySent) return undefined;
    }
    this.logger.info(JSON.stringify({ component: 'auto-reply-guard', event: 'default_reply', accountId: input.context.conversation.accountId, conversationId: input.context.conversation.id, runId: input.runId }));
    return { text: fallback.content, decision: 'reply', reason: 'default_reply' };
  }
}

export interface AutoRateClient {
  rateOrder(adminId: string, accountId: string, orderNo: string, feedback: string): Promise<{ status: 'succeeded' | 'failed' | 'unknown'; errorCode?: string; message?: string }>;
}

/** Rates the buyer once the platform reports the trade as received / completed. */
export class AutoRateService {
  private readonly rated = new Set<string>();

  constructor(
    private readonly store: Pick<Store, 'getAutoReplyAgentConfig'>,
    private readonly xianyu: AutoRateClient,
    private readonly audit: (input: { actorId: string; action: string; targetRef?: string; requestId: string; traceId: string; payload: unknown; accountId?: string }) => Promise<string>,
    private readonly logger: Pick<Console, 'info' | 'warn'> = console,
  ) {}

  async onSystemMessage(input: { adminId: string; accountId: string; event: XianyuImMessageEventLike; kind?: string; orderNo?: string }): Promise<'rated' | 'skipped'> {
    if (input.kind !== 'received' && input.kind !== 'trade_success') return 'skipped';
    const orderNo = (input.orderNo ?? '').trim() || extractOrderNo(input.event.bodyText);
    if (!orderNo) {
      this.logger.info(JSON.stringify({ component: 'auto-rate', event: 'order_no_missing', accountId: input.accountId, messageRef: input.event.externalMessageRef }));
      return 'skipped';
    }
    const dedupeKey = `${input.accountId}:${orderNo}`;
    if (this.rated.has(dedupeKey)) return 'skipped';
    const settings = await this.store.getAutoReplyAgentConfig(input.adminId, input.accountId);
    const autoRate = settings?.replyPolicy?.autoRate;
    if (!autoRate?.enabled || !autoRate.content) return 'skipped';
    this.rated.add(dedupeKey);
    if (this.rated.size > 5_000) this.rated.delete(this.rated.values().next().value as string);
    const result = await this.xianyu.rateOrder(input.adminId, input.accountId, orderNo, autoRate.content);
    this.logger.info(JSON.stringify({ component: 'auto-rate', event: result.status === 'succeeded' ? 'rated' : 'rate_failed', accountId: input.accountId, orderNo, errorCode: result.errorCode }));
    await this.audit({ actorId: input.adminId, action: 'order.auto_rated', targetRef: orderNo, requestId: `auto-rate:${orderNo}`, traceId: `auto-rate:${orderNo}`, accountId: input.accountId, payload: { orderNo, status: result.status, errorCode: result.errorCode, message: result.message } }).catch(() => undefined);
    if (result.status !== 'succeeded') this.rated.delete(dedupeKey);
    return result.status === 'succeeded' ? 'rated' : 'skipped';
  }
}

function extractOrderNo(body: string | undefined): string | undefined {
  const match = /(?:订单号|订单编号|orderNo|订单)[:：\s]*([0-9]{12,})/u.exec(body ?? '') ?? /\b([0-9]{15,20})\b/u.exec(body ?? '');
  return match?.[1];
}
