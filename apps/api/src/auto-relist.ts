import type { AutoRelistJobRecord, ProductRecord, Store } from './domain.js';
import type { ProductAutomationService } from './product-automation.js';
import type { ProductPostageMode, ProductPublishImageInput, ProductPublishService } from './product-publish.js';
import { digestJson } from './security.js';
import { ServiceError } from './services.js';
import { downloadImage, type XianyuItemDetailService } from './xianyu-item-detail-service.js';

/**
 * 自动续售：商品成交付款后，用同一套标题/描述/图片/价格重新发布一条新链接，
 * 把自动发货配置、默认回复和知识库搬到新链接上，让"库存 1 件"的虚拟商品卖完一单后
 * 不用手动重发。开关存在商品 attributes.autoRelist；任务进 products.auto_relist_jobs 队列，
 * 由 worker 延迟执行并重试。
 */

export interface AutoRelistSettings {
  enabled: boolean;
  /** 成交后等多久再重发；给闲鱼留出订单落定的时间。 */
  delaySeconds: number;
}

export const DEFAULT_AUTO_RELIST_DELAY_SECONDS = 60;
export const MAX_AUTO_RELIST_DELAY_SECONDS = 86_400;
const MAX_BATCH = 50;
const MAX_IMAGES = 9;
const RETRY_BACKOFF_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000];

type AuditFn = (input: { actorId: string; action: string; targetRef?: string; requestId: string; traceId: string; payload: unknown; accountId?: string }) => Promise<string>;
type Logger = Pick<Console, 'info' | 'warn'>;
type PublishPort = Pick<ProductPublishService, 'publish'>;
type AutomationPort = Pick<ProductAutomationService, 'get' | 'update'>;
type AssetPort = Pick<XianyuItemDetailService, 'getAsset'>;
type ImageDownloader = (url: string) => Promise<{ body: Buffer; contentType: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function readAutoRelistSettings(product: Pick<ProductRecord, 'attributes'>): AutoRelistSettings {
  const raw = isRecord(product.attributes) && isRecord(product.attributes.autoRelist) ? product.attributes.autoRelist : {};
  const delay = Number(raw.delaySeconds);
  return {
    enabled: raw.enabled === true,
    delaySeconds: Number.isFinite(delay) ? Math.max(0, Math.min(MAX_AUTO_RELIST_DELAY_SECONDS, Math.trunc(delay))) : DEFAULT_AUTO_RELIST_DELAY_SECONDS,
  };
}

export interface AutoRelistBatchInput {
  adminId: string;
  accountId: string;
  productIds: string[];
  requestId: string;
  traceId: string;
}

export interface AutoRelistRunSummary {
  claimed: number;
  succeeded: number;
  failed: number;
  retried: number;
  skipped: number;
}

export class AutoRelistService {
  private readonly logger: Logger;
  private readonly download: ImageDownloader;

  constructor(
    private readonly store: Store,
    private readonly publisher: PublishPort,
    private readonly automation: AutomationPort,
    private readonly assets: AssetPort | undefined,
    private readonly audit: AuditFn,
    options: { logger?: Logger; downloadImage?: ImageDownloader; now?: () => number; retryBackoffMs?: number[] } = {},
  ) {
    this.logger = options.logger ?? console;
    this.download = options.downloadImage ?? ((url) => downloadImage(url));
    this.now = options.now ?? (() => Date.now());
    this.retryBackoffMs = options.retryBackoffMs?.length ? options.retryBackoffMs : RETRY_BACKOFF_MS;
  }

  private readonly now: () => number;
  private readonly retryBackoffMs: number[];

  /** 批量开关：写入 products.attributes.autoRelist，其它属性原样保留。 */
  async setAutoRelist(input: AutoRelistBatchInput & { enabled: boolean; delaySeconds?: number }): Promise<{ products: ProductRecord[] }> {
    const productIds = this.normalizeProductIds(input.productIds);
    await this.assertScope(input.adminId, input.accountId);
    const delaySeconds = input.delaySeconds === undefined ? undefined : Math.max(0, Math.min(MAX_AUTO_RELIST_DELAY_SECONDS, Math.trunc(Number(input.delaySeconds))));
    if (input.delaySeconds !== undefined && !Number.isFinite(delaySeconds)) throw new ServiceError(422, 'VALIDATION_FAILED', 'delaySeconds must be a number');
    const products: ProductRecord[] = [];
    for (const productId of productIds) {
      const product = await this.store.getProduct(input.adminId, productId);
      if (!product || product.accountId !== input.accountId) throw new ServiceError(404, 'NOT_FOUND', `商品不存在：${productId}`);
      const current = readAutoRelistSettings(product);
      const next: AutoRelistSettings = { enabled: input.enabled, delaySeconds: delaySeconds ?? current.delaySeconds };
      const updated = await this.store.updateProduct({ adminId: input.adminId, productId, expectedConfigVersion: product.configVersion, patch: { attributes: { ...product.attributes, autoRelist: { ...next, updatedAt: new Date(this.now()).toISOString() } } } });
      if (updated) products.push(updated);
    }
    await this.audit({ actorId: input.adminId, action: input.enabled ? 'product.auto_relist.enabled' : 'product.auto_relist.disabled', requestId: input.requestId, traceId: input.traceId, accountId: input.accountId, payload: { productIds, delaySeconds } });
    return { products };
  }

  /** 订单付款（含自动发货完成）后由付款 worker 调用；没开开关就什么都不做。 */
  async scheduleForOrder(input: { adminId: string; accountId: string; productId: string; orderNo: string }): Promise<AutoRelistJobRecord | undefined> {
    const product = await this.store.getProduct(input.adminId, input.productId);
    if (!product || product.accountId !== input.accountId) return undefined;
    const settings = readAutoRelistSettings(product);
    if (!settings.enabled) return undefined;
    if (!product.externalProductRef) return undefined;
    const dueAt = new Date(this.now() + settings.delaySeconds * 1_000).toISOString();
    const job = await this.store.enqueueAutoRelistJob({ adminId: input.adminId, accountId: input.accountId, productId: product.id, orderNo: input.orderNo, source: 'order', dueAt });
    this.logger.info(JSON.stringify({ component: 'auto-relist', event: 'scheduled', jobId: job.id, productId: product.id, orderNo: input.orderNo, dueAt }));
    return job;
  }

  /** 操作员手动点"立即续售"：不看开关，马上排队。 */
  async relistNow(input: AutoRelistBatchInput): Promise<{ jobs: AutoRelistJobRecord[] }> {
    const productIds = this.normalizeProductIds(input.productIds);
    await this.assertScope(input.adminId, input.accountId);
    const jobs: AutoRelistJobRecord[] = [];
    for (const productId of productIds) {
      const product = await this.store.getProduct(input.adminId, productId);
      if (!product || product.accountId !== input.accountId) throw new ServiceError(404, 'NOT_FOUND', `商品不存在：${productId}`);
      jobs.push(await this.store.enqueueAutoRelistJob({ adminId: input.adminId, accountId: input.accountId, productId, source: 'manual', dueAt: new Date(this.now()).toISOString() }));
    }
    await this.audit({ actorId: input.adminId, action: 'product.relist.requested', requestId: input.requestId, traceId: input.traceId, accountId: input.accountId, payload: { productIds, jobIds: jobs.map((job) => job.id) } });
    return { jobs };
  }

  async listJobs(adminId: string, query: { accountId?: string; productId?: string; limit?: number }): Promise<AutoRelistJobRecord[]> {
    if (query.accountId) await this.assertScope(adminId, query.accountId);
    return this.store.listAutoRelistJobs(adminId, { accountId: query.accountId, productId: query.productId, limit: Math.max(1, Math.min(200, query.limit ?? 50)) });
  }

  /** worker 入口：领取到期任务并逐个执行，单个失败不影响其它任务。 */
  async processDue(workerId: string, limit = 5, leaseMs = 10 * 60_000): Promise<AutoRelistRunSummary> {
    const summary: AutoRelistRunSummary = { claimed: 0, succeeded: 0, failed: 0, retried: 0, skipped: 0 };
    const jobs = await this.store.claimAutoRelistJobs({ workerId, limit, leaseMs });
    summary.claimed = jobs.length;
    for (const job of jobs) {
      const outcome = await this.runJob(job);
      summary[outcome] += 1;
    }
    return summary;
  }

  async runJob(job: AutoRelistJobRecord): Promise<'succeeded' | 'failed' | 'retried' | 'skipped'> {
    const ownerToken = job.ownerToken ?? '';
    const requestId = `auto-relist:${job.id}:${job.attemptCount}`;
    try {
      const product = await this.store.getProduct(job.adminId, job.productId);
      if (!product) {
        await this.store.finishAutoRelistJob({ id: job.id, ownerToken, status: 'skipped', lastError: 'PRODUCT_MISSING' });
        return 'skipped';
      }
      const relisted = isRecord(product.attributes.relist) && product.attributes.relist.state === 'relisted' ? product.attributes.relist : undefined;
      if (job.source === 'order' && relisted) {
        // 同一商品已经续售过一次（比如两单几乎同时付款），不要再发第二条。
        await this.store.finishAutoRelistJob({ id: job.id, ownerToken, status: 'skipped', lastError: 'ALREADY_RELISTED', newProductId: typeof relisted.newProductId === 'string' ? relisted.newProductId : undefined });
        return 'skipped';
      }
      const result = await this.relistProduct(product, job, requestId);
      await this.store.finishAutoRelistJob({ id: job.id, ownerToken, status: 'succeeded', newProductId: result.product.id, newExternalProductRef: result.itemId });
      this.logger.info(JSON.stringify({ component: 'auto-relist', event: 'succeeded', jobId: job.id, productId: product.id, newProductId: result.product.id, itemId: result.itemId }));
      return 'succeeded';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const permanent = error instanceof ServiceError && error.statusCode === 422;
      const exhausted = job.attemptCount >= job.maxAttempts;
      if (permanent || exhausted) {
        await this.store.finishAutoRelistJob({ id: job.id, ownerToken, status: 'failed', lastError: message });
        this.logger.warn(JSON.stringify({ component: 'auto-relist', event: 'failed', jobId: job.id, productId: job.productId, attempt: job.attemptCount, reason: message }));
        return 'failed';
      }
      const backoff = this.retryBackoffMs[Math.min(this.retryBackoffMs.length - 1, Math.max(0, job.attemptCount - 1))]!;
      await this.store.finishAutoRelistJob({ id: job.id, ownerToken, status: 'pending', nextAttemptAt: new Date(this.now() + backoff).toISOString(), lastError: message });
      this.logger.warn(JSON.stringify({ component: 'auto-relist', event: 'retry_scheduled', jobId: job.id, productId: job.productId, attempt: job.attemptCount, backoffMs: backoff, reason: message }));
      return 'retried';
    }
  }

  private async relistProduct(product: ProductRecord, job: AutoRelistJobRecord, requestId: string): Promise<{ product: ProductRecord; itemId: string }> {
    if (!product.priceMinor || product.priceMinor <= 0) throw new ServiceError(422, 'RELIST_PRICE_MISSING', '商品没有价格，无法重新发布');
    const description = (product.description ?? '').trim() || this.detailDescription(product) || product.title;
    const publishMeta = isRecord(product.attributes.publish) ? product.attributes.publish : {};
    const postageMode = (['free', 'distance', 'fixed', 'none'] as const).includes(publishMeta.postageMode as ProductPostageMode) ? publishMeta.postageMode as ProductPostageMode : 'free';
    const images = await this.collectImages(product, job.adminId);
    if (images.length === 0) throw new ServiceError(422, 'RELIST_IMAGES_MISSING', '商品没有可用图片，无法重新发布');

    const published = await this.publisher.publish({
      adminId: job.adminId,
      accountId: product.accountId,
      title: product.title,
      description,
      categoryCode: product.categoryCode,
      priceMinor: product.priceMinor,
      originalPriceMinor: typeof publishMeta.originalPriceMinor === 'number' ? publishMeta.originalPriceMinor : undefined,
      postageMode,
      postageMinor: typeof publishMeta.postageMinor === 'number' ? publishMeta.postageMinor : undefined,
      images,
      requestId,
      traceId: requestId,
    });
    const next = published.product;
    const relistedAt = new Date(this.now()).toISOString();

    // 新链接继承：续售开关（链条继续）、默认回复、知识库、来源标记。
    const nextAttributes = { ...next.attributes, autoRelist: { ...readAutoRelistSettings(product), updatedAt: relistedAt }, relist: { state: 'relisted_from', fromProductId: product.id, fromExternalProductRef: product.externalProductRef, orderNo: job.orderNo, at: relistedAt, source: job.source } };
    const nextPatch = { attributes: nextAttributes, ...(product.defaultReplyTemplate ? { defaultReplyTemplate: product.defaultReplyTemplate } : {}), ...(product.knowledgeBase ? { knowledgeBase: product.knowledgeBase } : {}) };
    const nextProduct = await this.store.updateProduct({ adminId: job.adminId, productId: next.id, expectedConfigVersion: next.configVersion, patch: nextPatch }) ?? next;

    // 自动发货等自动化规则整套搬过去（卡券绑定由 store 同步）。
    const automation = await this.store.getProductAutomation(job.adminId, product.id);
    if (automation) {
      const target = await this.automation.get(job.adminId, next.id);
      await this.automation.update({ adminId: job.adminId, productId: next.id, expectedConfigVersion: target.configVersion, config: automation.config, requestId, traceId: requestId });
    }

    // 老链接：关掉它的续售开关（避免库存>1 时再触发），记录去向。
    const fresh = await this.store.getProduct(job.adminId, product.id);
    if (fresh) {
      await this.store.updateProduct({ adminId: job.adminId, productId: fresh.id, expectedConfigVersion: fresh.configVersion, patch: { attributes: { ...fresh.attributes, autoRelist: { ...readAutoRelistSettings(fresh), enabled: false, updatedAt: relistedAt }, relist: { state: 'relisted', newProductId: next.id, newExternalProductRef: published.itemId, orderNo: job.orderNo, at: relistedAt, source: job.source } } } }).catch((error) => {
        this.logger.warn(JSON.stringify({ component: 'auto-relist', event: 'mark_old_failed', productId: fresh.id, reason: error instanceof Error ? error.message : String(error) }));
      });
    }
    await this.audit({ actorId: job.adminId, action: 'product.relisted', targetRef: next.id, requestId, traceId: requestId, accountId: product.accountId, payload: { fromProductId: product.id, fromItemId: product.externalProductRef, itemId: published.itemId, orderNo: job.orderNo, source: job.source, images: images.length, automationCopied: Boolean(automation), configDigest: automation ? digestJson(automation.config) : undefined } });
    return { product: nextProduct, itemId: published.itemId };
  }

  private detailDescription(product: ProductRecord): string | undefined {
    const xianyu = isRecord(product.attributes.xianyu) ? product.attributes.xianyu : undefined;
    const detail = xianyu && isRecord(xianyu.detail) ? xianyu.detail : undefined;
    const summary = detail && isRecord(detail.summary) ? detail.summary : undefined;
    return summary && typeof summary.description === 'string' && summary.description.trim() ? summary.description.trim() : undefined;
  }

  private async collectImages(product: ProductRecord, adminId: string): Promise<ProductPublishImageInput[]> {
    const images: ProductPublishImageInput[] = [];
    const failures: string[] = [];
    // 1) 本地已落库的商品图片（同步/详情抓取时存进对象存储的）。
    for (const asset of (product.assets ?? []).filter((item) => item.status === 'active' && item.mimeType.startsWith('image/'))) {
      if (images.length >= MAX_IMAGES) break;
      try {
        const loaded = await this.assets?.getAsset({ adminId, productId: product.id, assetId: asset.id });
        if (loaded) images.push({ filename: `${asset.id}.${extensionFor(loaded.object.contentType)}`, contentType: loaded.object.contentType, data: loaded.object.body });
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (images.length > 0) return images;
    // 2) 发布/同步时记录的闲鱼图片地址，重新下载。
    const publishMeta = isRecord(product.attributes.publish) ? product.attributes.publish : {};
    const xianyu = isRecord(product.attributes.xianyu) ? product.attributes.xianyu : {};
    const urls = [publishMeta.imageUrls, xianyu.imageUrls].find((value): value is string[] => Array.isArray(value) && value.length > 0) ?? [];
    for (const [index, url] of urls.slice(0, MAX_IMAGES).entries()) {
      if (typeof url !== 'string' || !url.trim()) continue;
      try {
        const downloaded = await this.download(url);
        images.push({ filename: `relist-${index + 1}.${extensionFor(downloaded.contentType)}`, contentType: downloaded.contentType, data: downloaded.body });
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (images.length === 0 && failures.length > 0) this.logger.warn(JSON.stringify({ component: 'auto-relist', event: 'images_unavailable', productId: product.id, failures: failures.slice(0, 3) }));
    return images;
  }

  private normalizeProductIds(productIds: unknown): string[] {
    if (!Array.isArray(productIds)) throw new ServiceError(422, 'VALIDATION_FAILED', 'productIds must be an array');
    const ids = [...new Set(productIds.map((value) => String(value ?? '').trim()).filter(Boolean))];
    if (ids.length === 0) throw new ServiceError(422, 'VALIDATION_FAILED', '至少选择一个商品');
    if (ids.length > MAX_BATCH) throw new ServiceError(422, 'VALIDATION_FAILED', `一次最多处理 ${MAX_BATCH} 个商品`);
    return ids;
  }

  private async assertScope(adminId: string, accountId: string): Promise<void> {
    if (!accountId.trim() || !(await this.store.hasAccountScope(adminId, accountId))) throw new ServiceError(403, 'FORBIDDEN', 'account scope required');
  }
}

function extensionFor(contentType: string): string {
  const normalized = contentType.toLowerCase();
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('gif')) return 'gif';
  return 'jpg';
}

export interface AutoRelistWorkerOptions {
  workerId: string;
  enabled?: boolean;
  pollMs?: number;
  batchSize?: number;
  leaseMs?: number;
  onError?: (error: unknown) => void;
}

export class AutoRelistWorker {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly enabled: boolean;
  private readonly pollMs: number;
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly onError: (error: unknown) => void;

  constructor(private readonly service: Pick<AutoRelistService, 'processDue'>, private readonly options: AutoRelistWorkerOptions) {
    this.enabled = options.enabled ?? true;
    this.pollMs = Math.max(5_000, options.pollMs ?? 30_000);
    this.batchSize = Math.max(1, Math.min(20, options.batchSize ?? 5));
    this.leaseMs = Math.max(60_000, options.leaseMs ?? 10 * 60_000);
    this.onError = options.onError ?? (() => undefined);
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => { void this.poll(); }, this.pollMs);
    this.timer.unref?.();
    void this.poll();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async poll(): Promise<AutoRelistRunSummary | undefined> {
    if (this.running) return undefined;
    this.running = true;
    try {
      return await this.service.processDue(this.options.workerId, this.batchSize, this.leaseMs);
    } catch (error) {
      this.onError(error);
      return undefined;
    } finally {
      this.running = false;
    }
  }
}
