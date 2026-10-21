import type { ConversationSide, Store } from './domain.js';

export type { ConversationSide } from './domain.js';

/** The subset of the Xianyu MTOP client needed to learn who sells the item a conversation is about. */
export interface ConversationSideItemDetailClient {
  fetchItemDetail(adminId: string, accountId: string, itemId: string): Promise<{ success: boolean; summary?: { sellerId?: string } }>;
}

export interface ConversationSideResolverOptions {
  /** How long a resolved seller/buyer verdict stays cached per item. */
  cacheTtlMs?: number;
  /** How long an unknown verdict (lookup failure) is cached to avoid hammering the detail API. */
  unknownTtlMs?: number;
  now?: () => number;
}

/**
 * Decides which side of a conversation the connected account is on.
 *
 * Xianyu chats are always attached to an item. When that item is one of the
 * account's own listings the account is the seller and the counterpart is a
 * buyer; when the item belongs to someone else the account is the buyer and
 * must never be answered by the auto-reply agent.
 *
 * Resolution order:
 * 1. the local product table (synced or published listings) — cheap and authoritative;
 * 2. the item detail API, comparing `sellerDO.sellerId` with the account identity;
 * 3. `unknown` when the item is missing or the lookup fails — callers treat it as "do not reply".
 */
export class ConversationSideResolver {
  private readonly cache = new Map<string, { side: ConversationSide; expiresAt: number }>();
  private readonly cacheTtlMs: number;
  private readonly unknownTtlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly store: Pick<Store, 'getAccount' | 'getAutoReplyProduct'>,
    private readonly itemDetail?: Partial<ConversationSideItemDetailClient>,
    options: ConversationSideResolverOptions = {},
  ) {
    this.cacheTtlMs = Math.max(1_000, options.cacheTtlMs ?? 6 * 60 * 60 * 1_000);
    this.unknownTtlMs = Math.max(0, options.unknownTtlMs ?? 60 * 1_000);
    this.now = options.now ?? (() => Date.now());
  }

  async resolve(input: { adminId: string; accountId: string; itemRef?: string }): Promise<ConversationSide> {
    const itemRef = input.itemRef?.trim();
    if (!itemRef) return 'unknown';
    const cacheKey = `${input.accountId}\u0000${itemRef}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) return cached.side;

    const product = await this.store.getAutoReplyProduct(input.adminId, { accountId: input.accountId, externalProductRef: itemRef }).catch(() => undefined);
    if (product) return this.remember(cacheKey, 'seller');

    const fetchItemDetail = this.itemDetail?.fetchItemDetail;
    if (typeof fetchItemDetail !== 'function') return 'unknown';
    const account = await this.store.getAccount(input.adminId, input.accountId);
    const selfIds = new Set([account?.sellerRef, account?.platformUserId].filter((value): value is string => Boolean(value && value.trim())));
    if (selfIds.size === 0) return 'unknown';
    try {
      const detail = await fetchItemDetail.call(this.itemDetail, input.adminId, input.accountId, itemRef);
      const sellerId = detail.summary?.sellerId?.trim();
      if (!detail.success || !sellerId) return this.remember(cacheKey, 'unknown');
      return this.remember(cacheKey, selfIds.has(sellerId) ? 'seller' : 'buyer');
    } catch {
      return this.remember(cacheKey, 'unknown');
    }
  }

  private remember(key: string, side: ConversationSide): ConversationSide {
    const ttl = side === 'unknown' ? this.unknownTtlMs : this.cacheTtlMs;
    if (ttl > 0) this.cache.set(key, { side, expiresAt: this.now() + ttl });
    return side;
  }
}

/** Only buyers asking about the account's own listings may receive automatic replies. */
export function autoReplyAllowedForSide(side: ConversationSide): boolean {
  return side === 'seller';
}
