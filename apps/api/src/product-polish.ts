import type { AccountRecord, ProductRecord, Store } from './domain.js';
import type { XianyuMtopClient } from './xianyu-mtop.js';

/**
 * 商品擦亮（polish）。
 *
 * 擦亮把商品重新推到搜索与推荐列表前面，是平台提供的免费曝光手段。接口是
 * `mtop.taobao.idle.item.polish`（H5 签名，版本 2.0），每个商品每天只能擦亮一次，
 * 重复调用返回业务错误而不是异常。这里按账号开关（`accounts.auto_polish`）
 * 定时批量执行，并在内存里记住每个商品最近一次尝试，避免同一天反复打接口。
 */
export const POLISH_API = 'mtop.taobao.idle.item.polish';
export const POLISH_API_VERSION = '2.0';

export interface ProductPolishOptions {
  /** Minimum gap between two polish attempts of the same product. */
  intervalMs?: number;
  /** Random pause between two items of the same account, to stay under rate limits. */
  perItemDelayMs?: [number, number];
  /** Safety cap per account per run. */
  maxItemsPerRun?: number;
  pageSize?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  logger?: Pick<Console, 'info' | 'warn'>;
}

export interface ProductPolishItemResult {
  productId: string;
  itemId: string;
  title: string;
  outcome: 'polished' | 'already_polished' | 'rejected' | 'failed' | 'skipped';
  message?: string;
}

export interface ProductPolishAccountResult {
  adminId: string;
  accountId: string;
  total: number;
  polished: number;
  alreadyPolished: number;
  failed: number;
  skipped: number;
  /** Set when the account loop stopped early (credential invalid / validation required). */
  stoppedReason?: string;
  items: ProductPolishItemResult[];
}

export interface ProductPolishRunResult {
  accounts: number;
  polished: number;
  alreadyPolished: number;
  failed: number;
  results: ProductPolishAccountResult[];
}

type PolishMtop = Pick<XianyuMtopClient, 'call'>;

const DEFAULT_INTERVAL_MS = 24 * 60 * 60_000;
const DEFAULT_DELAY: [number, number] = [3_000, 8_000];

export class ProductPolishService {
  private readonly intervalMs: number;
  private readonly perItemDelayMs: [number, number];
  private readonly maxItemsPerRun: number;
  private readonly pageSize: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly logger: Pick<Console, 'info' | 'warn'>;
  /** productId -> epoch ms of the last attempt that counted (success or "already polished"). */
  private readonly lastAttempt = new Map<string, number>();

  constructor(private readonly store: Store, private readonly mtop: PolishMtop, options: ProductPolishOptions = {}) {
    this.intervalMs = Math.max(60_000, options.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.perItemDelayMs = options.perItemDelayMs ?? DEFAULT_DELAY;
    this.maxItemsPerRun = Math.max(1, options.maxItemsPerRun ?? 200);
    this.pageSize = Math.max(1, Math.min(100, options.pageSize ?? 100));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.logger = options.logger ?? console;
  }

  /** Polish every eligible product of one account. `force` ignores the per-product interval. */
  async polishAccount(adminId: string, accountId: string, options: { force?: boolean } = {}): Promise<ProductPolishAccountResult> {
    const result: ProductPolishAccountResult = { adminId, accountId, total: 0, polished: 0, alreadyPolished: 0, failed: 0, skipped: 0, items: [] };
    const products = await this.listPolishableProducts(adminId, accountId);
    result.total = products.length;
    let sent = 0;
    for (const product of products) {
      const itemId = product.externalProductRef!;
      const last = this.lastAttempt.get(product.id);
      if (!options.force && last !== undefined && this.now() - last < this.intervalMs) {
        result.skipped += 1;
        result.items.push({ productId: product.id, itemId, title: product.title, outcome: 'skipped', message: 'interval_not_elapsed' });
        continue;
      }
      if (sent >= this.maxItemsPerRun) {
        result.skipped += 1;
        result.items.push({ productId: product.id, itemId, title: product.title, outcome: 'skipped', message: 'run_cap_reached' });
        continue;
      }
      if (sent > 0) await this.sleep(this.randomDelay());
      sent += 1;
      const response = await this.mtop.call(adminId, accountId, POLISH_API, POLISH_API_VERSION, { itemId });
      const message = (response.message ?? response.errorCode ?? '').toString();
      if (response.success) {
        this.lastAttempt.set(product.id, this.now());
        result.polished += 1;
        result.items.push({ productId: product.id, itemId, title: product.title, outcome: 'polished', message });
        continue;
      }
      if (response.accountInvalid || response.errorCode === 'ACCOUNT_VALIDATION_REQUIRED') {
        result.failed += 1;
        result.items.push({ productId: product.id, itemId, title: product.title, outcome: 'failed', message });
        result.stoppedReason = response.errorCode ?? 'ACCOUNT_INVALID';
        this.logger.warn(JSON.stringify({ component: 'product-polish', event: 'account_stopped', adminId, accountId, reason: result.stoppedReason }));
        break;
      }
      if (isAlreadyPolishedMessage(message)) {
        // The platform already counted today's polish; do not retry until the interval passes.
        this.lastAttempt.set(product.id, this.now());
        result.alreadyPolished += 1;
        result.items.push({ productId: product.id, itemId, title: product.title, outcome: 'already_polished', message });
        continue;
      }
      result.failed += 1;
      result.items.push({ productId: product.id, itemId, title: product.title, outcome: 'rejected', message });
    }
    this.logger.info(JSON.stringify({ component: 'product-polish', event: 'account_polished', adminId, accountId, total: result.total, polished: result.polished, alreadyPolished: result.alreadyPolished, failed: result.failed, skipped: result.skipped, stoppedReason: result.stoppedReason }));
    return result;
  }

  /** Polish every account that opted in (`autoPolish`), across all admins. */
  async polishAll(): Promise<ProductPolishRunResult> {
    const run: ProductPolishRunResult = { accounts: 0, polished: 0, alreadyPolished: 0, failed: 0, results: [] };
    for (const adminId of await this.store.listAdminIds()) {
      for (const account of await this.listAutoPolishAccounts(adminId)) {
        run.accounts += 1;
        try {
          const result = await this.polishAccount(adminId, account.id);
          run.polished += result.polished;
          run.alreadyPolished += result.alreadyPolished;
          run.failed += result.failed;
          run.results.push(result);
        } catch (error) {
          run.failed += 1;
          this.logger.warn(JSON.stringify({ component: 'product-polish', event: 'account_failed', adminId, accountId: account.id, reason: error instanceof Error ? error.message : String(error) }));
        }
      }
    }
    return run;
  }

  private async listAutoPolishAccounts(adminId: string): Promise<AccountRecord[]> {
    const accounts: AccountRecord[] = [];
    let page = 1;
    while (true) {
      const result = await this.store.listAccounts(adminId, { page, pageSize: 100 });
      for (const account of result.items) {
        if (account.autoPolish && !['disabled', 'expired', 'verification_required'].includes(account.status)) accounts.push(account);
      }
      if (page >= result.totalPages) break;
      page += 1;
    }
    return accounts;
  }

  private async listPolishableProducts(adminId: string, accountId: string): Promise<ProductRecord[]> {
    const products: ProductRecord[] = [];
    let page = 1;
    while (true) {
      const result = await this.store.listProducts(adminId, { accountId, page, pageSize: this.pageSize, sortBy: 'xianyuOrder', sortOrder: 'asc' });
      for (const product of result.items) {
        if (!product.externalProductRef || product.status === 'archived' || product.status === 'draft') continue;
        products.push(product);
      }
      if (page >= result.totalPages) break;
      page += 1;
    }
    return products;
  }

  private randomDelay(): number {
    const [min, max] = this.perItemDelayMs;
    return Math.floor(min + this.random() * Math.max(0, max - min));
  }
}

export function isAlreadyPolishedMessage(message: string): boolean {
  return /已擦亮|今日已|已经擦亮|次数已用完|上限|超过.*次|FAIL_BIZ_.*LIMIT/i.test(message);
}

export interface ProductPolishWorkerOptions {
  enabled?: boolean;
  pollMs?: number;
  onError?: (error: unknown) => void;
}

export class ProductPolishWorker {
  private readonly enabled: boolean;
  private readonly pollMs: number;
  private readonly onError: (error: unknown) => void;
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<ProductPolishRunResult>;

  constructor(private readonly service: ProductPolishService, options: ProductPolishWorkerOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.pollMs = Math.max(60_000, options.pollMs ?? 30 * 60_000);
    this.onError = options.onError ?? (() => undefined);
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    // Spread the first run a little so several workers do not all hit Xianyu at boot.
    setTimeout(() => { void this.pollOnce().catch(this.onError); }, 15_000).unref?.();
    this.timer = setInterval(() => { void this.pollOnce().catch(this.onError); }, this.pollMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  async pollOnce(): Promise<ProductPolishRunResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.service.polishAll().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }
}
