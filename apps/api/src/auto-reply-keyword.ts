import type { AutoReplyGeneratedReply, AutoReplyGenerator } from './auto-reply.js';
import { ServiceError } from './services.js';

/**
 * 关键词快速回复。
 *
 * 买家的很多问题是固定的（"发货了吗""怎么用""能便宜吗"），走大模型既慢又贵，
 * 答案还可能飘。规则存在账号级自动回复配置里（`keywordRules`），
 * `KeywordFirstAutoReplyGenerator` 包住原来的模型 Agent：命中规则直接按规则回复，
 * 没命中才交给模型。接管、发送延迟、发送结果审核等主链路行为不变。
 */
export type KeywordMatchMode = 'contains' | 'exact' | 'regex';

export interface AutoReplyKeywordRule {
  id: string;
  /** Any keyword matching triggers the rule. */
  keywords: string[];
  reply: string;
  matchMode: KeywordMatchMode;
  /** Restrict the rule to one Xianyu item (externalProductRef / itemRef); empty = every item. */
  productRef?: string;
  enabled: boolean;
}

export const MAX_KEYWORD_RULES = 200;
export const MAX_KEYWORDS_PER_RULE = 50;
export const MAX_KEYWORD_LENGTH = 200;
export const MAX_KEYWORD_REPLY_LENGTH = 2_000;
const MATCH_MODES: readonly KeywordMatchMode[] = ['contains', 'exact', 'regex'];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanKeywords(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,，\n]/u) : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of list) {
    const keyword = String(item ?? '').replace(/\s+/gu, ' ').trim();
    if (!keyword || keyword.length > MAX_KEYWORD_LENGTH || seen.has(keyword)) continue;
    seen.add(keyword);
    result.push(keyword);
  }
  return result;
}

/** Lenient reader used when loading persisted config: invalid rules are dropped, never thrown. */
export function sanitizeKeywordRules(raw: unknown): AutoReplyKeywordRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: AutoReplyKeywordRule[] = [];
  for (const [index, item] of raw.entries()) {
    const record = asRecord(item);
    const keywords = cleanKeywords(record.keywords);
    const reply = String(record.reply ?? '').trim();
    const matchMode = MATCH_MODES.includes(record.matchMode as KeywordMatchMode) ? record.matchMode as KeywordMatchMode : 'contains';
    if (keywords.length === 0 || !reply) continue;
    if (matchMode === 'regex' && !keywords.every(isValidRegex)) continue;
    const productRef = String(record.productRef ?? '').trim();
    rules.push({
      id: String(record.id ?? '').trim() || `kw-${index + 1}`,
      keywords: keywords.slice(0, MAX_KEYWORDS_PER_RULE),
      reply: reply.slice(0, MAX_KEYWORD_REPLY_LENGTH),
      matchMode,
      ...(productRef ? { productRef } : {}),
      enabled: record.enabled !== false,
    });
    if (rules.length >= MAX_KEYWORD_RULES) break;
  }
  return rules;
}

/** Strict validator used on writes: the first problem is reported as a 422. */
export function validateKeywordRules(raw: unknown): AutoReplyKeywordRule[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ServiceError(422, 'VALIDATION_FAILED', 'keywordRules must be an array');
  if (raw.length > MAX_KEYWORD_RULES) throw new ServiceError(422, 'VALIDATION_FAILED', `keywordRules supports at most ${MAX_KEYWORD_RULES} rules`);
  const ids = new Set<string>();
  return raw.map((item, index) => {
    const record = asRecord(item);
    const label = `keywordRules[${index}]`;
    const keywords = cleanKeywords(record.keywords);
    if (keywords.length === 0) throw new ServiceError(422, 'VALIDATION_FAILED', `${label}.keywords must contain at least one keyword`);
    if (keywords.length > MAX_KEYWORDS_PER_RULE) throw new ServiceError(422, 'VALIDATION_FAILED', `${label}.keywords supports at most ${MAX_KEYWORDS_PER_RULE} keywords`);
    const reply = String(record.reply ?? '').trim();
    if (!reply) throw new ServiceError(422, 'VALIDATION_FAILED', `${label}.reply must be a non-empty string`);
    if (reply.length > MAX_KEYWORD_REPLY_LENGTH) throw new ServiceError(422, 'VALIDATION_FAILED', `${label}.reply is too long`);
    const matchMode = record.matchMode === undefined ? 'contains' : record.matchMode;
    if (!MATCH_MODES.includes(matchMode as KeywordMatchMode)) throw new ServiceError(422, 'VALIDATION_FAILED', `${label}.matchMode must be contains, exact or regex`);
    if (matchMode === 'regex') {
      const bad = keywords.find((keyword) => !isValidRegex(keyword));
      if (bad) throw new ServiceError(422, 'VALIDATION_FAILED', `${label}.keywords contains an invalid regular expression: ${bad}`);
    }
    let id = String(record.id ?? '').trim() || `kw-${index + 1}`;
    while (ids.has(id)) id = `${id}-${index + 1}`;
    ids.add(id);
    const productRef = String(record.productRef ?? '').trim();
    return { id, keywords, reply, matchMode: matchMode as KeywordMatchMode, ...(productRef ? { productRef } : {}), enabled: record.enabled !== false };
  });
}

function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern, 'iu');
    return true;
  } catch {
    return false;
  }
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().toLowerCase();
}

const regexCache = new Map<string, RegExp>();
function compiled(pattern: string): RegExp | undefined {
  const cached = regexCache.get(pattern);
  if (cached) return cached;
  try {
    const regex = new RegExp(pattern, 'iu');
    if (regexCache.size > 2_000) regexCache.clear();
    regexCache.set(pattern, regex);
    return regex;
  } catch {
    return undefined;
  }
}

/** First enabled rule whose scope and keywords match wins; rules are evaluated in list order. */
export function matchKeywordRule(rules: readonly AutoReplyKeywordRule[], text: string, productRef?: string): AutoReplyKeywordRule | undefined {
  const normalized = normalizeText(text);
  if (!normalized) return undefined;
  const scope = productRef?.trim();
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.productRef && rule.productRef !== scope) continue;
    for (const keyword of rule.keywords) {
      if (rule.matchMode === 'regex') {
        if (compiled(keyword)?.test(text)) return rule;
        continue;
      }
      const needle = normalizeText(keyword);
      if (!needle) continue;
      if (rule.matchMode === 'exact' ? normalized === needle : normalized.includes(needle)) return rule;
    }
  }
  return undefined;
}

export type KeywordRulesLoader = (adminId: string | undefined, accountId: string) => Promise<readonly AutoReplyKeywordRule[]>;

export interface KeywordFirstAutoReplyGeneratorOptions {
  cacheMs?: number;
  now?: () => number;
  logger?: Pick<Console, 'info' | 'warn'>;
}

type GenerateInput = Parameters<AutoReplyGenerator['generate']>[0];

export class KeywordFirstAutoReplyGenerator implements AutoReplyGenerator {
  private readonly cacheMs: number;
  private readonly now: () => number;
  private readonly logger: Pick<Console, 'info' | 'warn'>;
  private readonly cache = new Map<string, { rules: readonly AutoReplyKeywordRule[]; expiresAt: number }>();

  constructor(
    private readonly loadRules: KeywordRulesLoader,
    private readonly inner?: AutoReplyGenerator,
    options: KeywordFirstAutoReplyGeneratorOptions = {},
  ) {
    this.cacheMs = Math.max(0, options.cacheMs ?? 15_000);
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
  }

  get supportsStructuredDecision(): boolean | undefined {
    return this.inner?.supportsStructuredDecision;
  }

  get supportsMultimodal(): boolean | undefined {
    return this.inner?.supportsMultimodal;
  }

  async generate(input: GenerateInput): Promise<string | AutoReplyGeneratedReply | undefined> {
    const accountId = input.context.conversation.accountId;
    const rules = await this.rulesFor(input.adminId, accountId);
    if (rules.length > 0 && input.context.inboundMessage.bodyType === 'text') {
      const pending = (input.context.pendingBuyerMessages ?? []).map((message) => message.bodyText ?? '').filter(Boolean);
      const texts = pending.length > 0 ? pending : [input.context.inboundMessage.bodyText ?? ''];
      const productRef = input.context.product?.externalProductRef ?? input.context.conversation.itemRef;
      for (const text of texts) {
        const rule = matchKeywordRule(rules, text, productRef);
        if (!rule) continue;
        this.logger.info(JSON.stringify({ component: 'auto-reply-keyword', event: 'keyword_reply', accountId, conversationId: input.context.conversation.id, ruleId: rule.id, runId: input.runId }));
        return { text: rule.reply, decision: 'reply', reason: `keyword:${rule.id}` };
      }
    }
    return this.inner ? this.inner.generate(input) : undefined;
  }

  async segmentReply(input: { reply: string; signal?: AbortSignal; deadlineAt?: number }): Promise<string[] | undefined> {
    return this.inner?.segmentReply ? this.inner.segmentReply(input) : undefined;
  }

  invalidate(accountId?: string): void {
    if (!accountId) this.cache.clear();
    else for (const key of this.cache.keys()) if (key.endsWith(`\u0000${accountId}`)) this.cache.delete(key);
  }

  private async rulesFor(adminId: string | undefined, accountId: string): Promise<readonly AutoReplyKeywordRule[]> {
    const key = `${adminId ?? ''}\u0000${accountId}`;
    const now = this.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached.rules;
    let rules: readonly AutoReplyKeywordRule[] = [];
    try {
      rules = (await this.loadRules(adminId, accountId)).filter((rule) => rule.enabled);
    } catch (error) {
      this.logger.warn(JSON.stringify({ component: 'auto-reply-keyword', event: 'rules_load_failed', accountId, reason: error instanceof Error ? error.message : String(error) }));
    }
    this.cache.set(key, { rules, expiresAt: now + this.cacheMs });
    return rules;
  }
}
