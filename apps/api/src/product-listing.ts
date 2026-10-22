import type { ProductRecord, Store } from './domain.js';
import { ServiceError } from './services.js';
import type { XianyuExternalMutationResult, XianyuMtopClient } from './xianyu-mtop.js';

export type ProductListingAction = 'offline' | 'delete';
export type ProductListingState = 'offline' | 'deleted';

export interface ProductListingItemResult {
  productId: string;
  externalProductRef?: string;
  title: string;
  status: 'succeeded' | 'failed' | 'unknown';
  errorCode?: string;
  message?: string;
}

export interface ProductListingResult {
  action: ProductListingAction;
  items: ProductListingItemResult[];
  succeeded: number;
  failed: number;
  products: ProductRecord[];
}

export interface ProductListingInput {
  adminId: string;
  accountId: string;
  productIds: string[];
  requestId: string;
  traceId: string;
}

type ListingClient = Pick<XianyuMtopClient, 'offlineItems' | 'deleteItem'>;
type AuditFn = (input: { actorId: string; action: string; targetRef?: string; requestId: string; traceId: string; payload: unknown; accountId?: string }) => Promise<string>;

const MAX_BATCH = 50;

function readListingState(product: ProductRecord): string | undefined {
  const listing = product.attributes?.listing;
  if (!listing || typeof listing !== 'object' || Array.isArray(listing)) return undefined;
  const state = (listing as { state?: unknown }).state;
  return typeof state === 'string' ? state : undefined;
}

/**
 * Takes the account's own listings off the shelf or deletes them on Xianyu,
 * then records the listing state on the local product so the catalogue shows
 * it immediately (the next Xianyu sync reconciles the canonical status).
 *
 * A deleted listing is also archived: it drops out of the default product list
 * and the dashboard, but stays in the database so orders keep their reference
 * and the 「已归档」 filter can still show it.
 */
export class ProductListingService {
  constructor(
    private readonly store: Store,
    private readonly xianyu: ListingClient,
    private readonly audit: AuditFn,
  ) {}

  offline(input: ProductListingInput): Promise<ProductListingResult> {
    return this.run('offline', input);
  }

  delete(input: ProductListingInput): Promise<ProductListingResult> {
    return this.run('delete', input);
  }

  private async run(action: ProductListingAction, input: ProductListingInput): Promise<ProductListingResult> {
    const productIds = [...new Set(input.productIds.map((id) => String(id ?? '').trim()).filter(Boolean))];
    if (productIds.length === 0) throw new ServiceError(422, 'VALIDATION_FAILED', 'productIds is required');
    if (productIds.length > MAX_BATCH) throw new ServiceError(422, 'VALIDATION_FAILED', `一次最多处理 ${MAX_BATCH} 个商品`);
    if (!(await this.store.hasAccountScope(input.adminId, input.accountId))) throw new ServiceError(403, 'FORBIDDEN', 'account scope required');

    const items: ProductListingItemResult[] = [];
    const targets: ProductRecord[] = [];
    for (const productId of productIds) {
      const product = await this.store.getProduct(input.adminId, productId);
      if (!product || product.accountId !== input.accountId) {
        items.push({ productId, title: '', status: 'failed', errorCode: 'NOT_FOUND', message: '商品不存在或不属于当前账号' });
        continue;
      }
      if (!product.externalProductRef) {
        items.push({ productId, title: product.title, status: 'failed', errorCode: 'NOT_PUBLISHED', message: '商品尚未发布到闲鱼，无需下架' });
        continue;
      }
      if (product.status === 'archived' || readListingState(product) === 'deleted') {
        // Already gone from Xianyu; taking it offline again would only smear a second marker over the deleted one.
        items.push({ productId, title: product.title, status: 'failed', errorCode: 'ALREADY_DELETED', message: '商品已删除，无需再操作' });
        continue;
      }
      targets.push(product);
    }

    const outcomes = new Map<string, { status: ProductListingItemResult['status']; errorCode?: string; message?: string }>();
    if (targets.length > 0) {
      if (action === 'offline') {
        const result = await this.xianyu.offlineItems(input.adminId, input.accountId, targets.map((product) => product.externalProductRef!));
        for (const product of targets) {
          const ref = product.externalProductRef!;
          const perItem = result.items?.find((item) => item.itemId === ref);
          const status = result.status === 'succeeded' ? (perItem && !perItem.success ? 'failed' : 'succeeded') : result.status;
          outcomes.set(product.id, { status, errorCode: status === 'succeeded' ? undefined : result.errorCode ?? (perItem ? 'ITEM_OFFLINE_REJECTED' : undefined), message: status === 'succeeded' ? undefined : result.message });
        }
      } else {
        for (const product of targets) {
          const result: XianyuExternalMutationResult = await this.xianyu.deleteItem(input.adminId, input.accountId, product.externalProductRef!);
          outcomes.set(product.id, { status: result.status, errorCode: result.status === 'succeeded' ? undefined : result.errorCode, message: result.status === 'succeeded' ? undefined : result.message });
        }
      }
    }

    const updated: ProductRecord[] = [];
    const state: ProductListingState = action === 'offline' ? 'offline' : 'deleted';
    for (const product of targets) {
      const outcome = outcomes.get(product.id) ?? { status: 'unknown' as const };
      items.push({ productId: product.id, externalProductRef: product.externalProductRef, title: product.title, status: outcome.status, errorCode: outcome.errorCode, message: outcome.message });
      if (outcome.status !== 'succeeded') continue;
      const attributes = { ...(product.attributes ?? {}), listing: { state, updatedAt: new Date().toISOString(), source: 'fishagent' } };
      const patch = state === 'deleted' ? { attributes, status: 'archived' as const } : { attributes };
      const record = await this.store.updateProduct({ adminId: input.adminId, productId: product.id, expectedConfigVersion: product.configVersion, patch }).catch(() => undefined);
      updated.push(record ?? product);
    }

    const succeeded = items.filter((item) => item.status === 'succeeded').length;
    await this.audit({
      actorId: input.adminId,
      action: action === 'offline' ? 'product.offline' : 'product.deleted',
      requestId: input.requestId,
      traceId: input.traceId,
      accountId: input.accountId,
      payload: { productIds, succeeded, failed: items.length - succeeded, items: items.map((item) => ({ productId: item.productId, externalProductRef: item.externalProductRef, status: item.status, errorCode: item.errorCode })) },
    });
    return { action, items, succeeded, failed: items.length - succeeded, products: updated };
  }
}
