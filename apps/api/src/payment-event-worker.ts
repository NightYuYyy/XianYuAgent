import { notify } from './notifier.js';
import type { OrderRecord, PaymentEventJob, Store, XianyuOrderItem } from './domain.js';
import type { XianyuMtopClient, XianyuOrdersPageResult } from './xianyu-mtop.js';
import type { ProductAutomationTriggerBatchResult } from './product-automation-trigger.js';

type ProcessOrder = (input: { adminId: string; accountId: string; items: OrderRecord[]; requestId: string; traceId: string }) => Promise<ProductAutomationTriggerBatchResult>;

export class PaymentEventWorker {
  private timer?: ReturnType<typeof setInterval>;
  private reconcileTimer?: ReturnType<typeof setInterval>;
  private claimInFlight?: Promise<PaymentEventJob[]>;
  private readonly activeJobs = new Set<Promise<void>>();
  private reconcileInFlight?: Promise<number>;
  private readonly reconcileCursors = new Map<string, number>();
  private readonly targetedScans = new Map<string, Promise<{ kind: 'complete' | 'handoff' } | { kind: 'retry'; error: string }>>();

  constructor(
    private readonly store: Store,
    private readonly mtop: Pick<XianyuMtopClient, 'fetchOrderCandidates'>,
    private readonly processOrder: ProcessOrder,
    private readonly options: { workerId: string; pollMs?: number; reconcileMs?: number; resolveDelaySeconds?: (adminId: string, order: OrderRecord) => Promise<number>; onError?: (error: unknown) => void },
  ) {}

  start(): void {
    if (this.timer) return;
    void this.pollOnce().catch(this.options.onError ?? (() => undefined));
    void this.reconcileOnce().catch(this.options.onError ?? (() => undefined));
    this.timer = setInterval(() => { void this.pollOnce().catch(this.options.onError ?? (() => undefined)); }, this.options.pollMs ?? 500);
    this.reconcileTimer = setInterval(() => { void this.reconcileOnce().catch(this.options.onError ?? (() => undefined)); }, this.options.reconcileMs ?? 30_000);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.timer = undefined;
    this.reconcileTimer = undefined;
    await this.claimInFlight;
    await Promise.allSettled([...this.activeJobs]);
    await this.reconcileInFlight;
  }

  async reconcileOnce(): Promise<number> {
    if (this.reconcileInFlight) return this.reconcileInFlight;
    this.reconcileInFlight = this.reconcileAccounts().finally(() => { this.reconcileInFlight = undefined; });
    return this.reconcileInFlight;
  }

  private async reconcileAccounts(): Promise<number> {
    let queued = 0;
    const active: Array<{ adminId: string; accountId: string; page: number; firstPage: number; hot: boolean; startedAt: number }> = [];
    for (const adminId of await this.store.listAdminIds()) {
      const admin = await this.store.findAdminById(adminId);
      if (admin?.status !== 'active') continue;
      let page = 1;
      let totalPages = 1;
      while (page <= totalPages) {
        const accounts = await this.store.listAccounts(adminId, { page, pageSize: 100 });
        totalPages = accounts.totalPages;
        for (const account of accounts.items) {
          if (!['connected', 'degraded', 'disconnected'].includes(account.status)) continue;
          active.push({ adminId, accountId: account.id, page: 1, firstPage: 1, hot: true, startedAt: Date.now() });
        }
        page += 1;
      }
    }
    while (active.length > 0) {
      const round = active.splice(0);
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(4, round.length) }, async () => {
        while (cursor < round.length) {
          const account = round[cursor++]!;
          try {
            const result = await this.mtop.fetchOrderCandidates(account.adminId, account.accountId, undefined, account.page);
            if (!result.success) {
              if (!account.hot && (this.reconcileCursors.get(account.accountId) ?? 0) < account.page) this.reconcileCursors.set(account.accountId, account.page);
              this.options.onError?.({ scope: 'payment_reconcile_lookup', accountId: account.accountId, errorCode: result.errorCode });
              if (account.hot && (this.reconcileCursors.get(account.accountId) ?? 1) > 100) {
                const firstPage = this.reconcileCursors.get(account.accountId)!;
                active.push({ ...account, page: firstPage, firstPage, hot: false });
              }
              continue;
            }
            for (const item of result.items) {
              if (item.paymentStatus !== 'paid' || item.deliveryStatus !== 'pending' || item.orderStatus !== 'open' || item.afterSalesStatus !== 'none' || item.buyerId === 'unknown-buyer' || item.itemId === 'unknown-item') continue;
              await this.store.enqueuePaymentEvent({ adminId: account.adminId, accountId: account.accountId, eventRef: `reconcile:${item.orderNo}`, orderNo: item.orderNo, buyerRef: item.buyerId, itemRef: item.itemId, conversationRef: item.conversationId ?? '', receivedAt: new Date().toISOString() });
              queued += 1;
            }
            if (account.hot) {
              if (result.hasMore && account.page < 100) active.push({ ...account, page: account.page + 1 });
              else if (result.hasMore) {
                const firstPage = Math.max(101, this.reconcileCursors.get(account.accountId) ?? 101);
                active.push({ ...account, page: firstPage, firstPage, hot: false });
              } else {
                this.reconcileCursors.delete(account.accountId);
                console.info(JSON.stringify({ component: 'payment-reconcile', event: 'account_scan', accountId: account.accountId, pages: account.page, durationMs: Date.now() - account.startedAt }));
              }
              continue;
            }
            if (result.hasMore && account.page < account.firstPage + 99) active.push({ ...account, page: account.page + 1 });
            else {
              if (result.hasMore) {
                this.reconcileCursors.set(account.accountId, account.page + 1);
                this.options.onError?.({ scope: 'payment_reconcile_continuing', accountId: account.accountId, nextPage: account.page + 1 });
              } else if (this.reconcileCursors.get(account.accountId) === account.firstPage) this.reconcileCursors.delete(account.accountId);
              console.info(JSON.stringify({ component: 'payment-reconcile', event: 'account_scan', accountId: account.accountId, pages: account.page - account.firstPage + 1, durationMs: Date.now() - account.startedAt }));
            }
          } catch (error) {
            if (!account.hot && (this.reconcileCursors.get(account.accountId) ?? 0) < account.page) this.reconcileCursors.set(account.accountId, account.page);
            this.options.onError?.({ scope: 'payment_reconcile', accountId: account.accountId, error });
          }
        }
      }));
    }
    if (queued) void this.pollOnce().catch(this.options.onError ?? (() => undefined));
    return queued;
  }

  async pollOnce(): Promise<number> {
    if (this.claimInFlight || this.activeJobs.size >= 8) return 0;
    if (!await this.store.isDeliveryCutoverActive()) return 0;
    const claim = this.store.claimPaymentEvents({ workerId: this.options.workerId, limit: 8 - this.activeJobs.size, leaseMs: 900_000 });
    this.claimInFlight = claim;
    let jobs: PaymentEventJob[];
    try { jobs = await claim; }
    finally { if (this.claimInFlight === claim) this.claimInFlight = undefined; }
    const started = jobs.map((job) => {
      const task = this.processJob(job).catch((error) => this.options.onError?.(error)).finally(() => { this.activeJobs.delete(task); });
      this.activeJobs.add(task);
      return task;
    });
    await Promise.all(started);
    return jobs.length;
  }

  private async processJob(job: PaymentEventJob): Promise<void> {
    try {
      const account = await this.store.getAccount(job.adminId, job.accountId);
      if (!account || account.status === 'disabled' || account.status === 'verification_required' || account.status === 'expired') {
        await this.defer(job, 'ACCOUNT_NOT_READY');
        return;
      }
      if (!job.orderNo) {
        let scan: { kind: 'complete' | 'handoff' } | { kind: 'retry'; error: string };
        try { scan = await this.scanAccountForExactOrders(job.adminId, job.accountId); }
        catch (error) { await this.defer(job, error instanceof Error ? error.message : 'ORDER_SCAN_FAILED', undefined, true); return; }
        if (scan.kind === 'retry') { await this.defer(job, scan.error, undefined, true); return; }
        await this.store.finishPaymentEvent({ id: job.id, ownerToken: job.ownerToken!, status: 'completed', lastError: scan.kind === 'handoff' ? 'ORDER_ID_UNAVAILABLE_RECONCILE_HANDOFF' : 'ORDER_ID_UNAVAILABLE_SCAN_COMPLETE' });
        return;
      }
      let item: XianyuOrderItem | undefined;
      if (job.orderNo) {
        const targeted = await this.mtop.fetchOrderCandidates(job.adminId, job.accountId, job.orderNo);
        if (!targeted.success) { await this.defer(job, targeted.errorCode ?? 'ORDER_LOOKUP_FAILED', undefined, true); return; }
        item = matchingCandidates(job, targeted)[0];
      }
      if (!item) {
        const matches: XianyuOrderItem[] = [];
        let complete = false;
        for (let orderPage = 1; orderPage <= 100; orderPage += 1) {
          const page = await this.mtop.fetchOrderCandidates(job.adminId, job.accountId, undefined, orderPage);
          if (!page.success) { await this.defer(job, page.errorCode ?? 'ORDER_LOOKUP_FAILED', undefined, true); return; }
          matches.push(...matchingCandidates(job, page));
          if (!page.hasMore) { complete = true; break; }
        }
        if (!complete) { await this.defer(job, 'ORDER_SCAN_TRUNCATED', undefined, true); return; }
        item = matches.length === 1 ? matches[0] : undefined;
      }
      if (!item) {
        await this.defer(job, 'ORDER_NOT_VISIBLE_OR_AMBIGUOUS', undefined, true);
        return;
      }
      if (isTerminalOrder(item)) {
        await this.store.finishPaymentEvent({ id: job.id, ownerToken: job.ownerToken!, status: 'completed', orderNo: item.orderNo, lastError: 'ORDER_NOT_ELIGIBLE' });
        return;
      }
      if (item.paymentStatus !== 'paid' || item.orderStatus !== 'open' || item.deliveryStatus !== 'pending') {
        await this.defer(job, 'ORDER_STATE_NOT_VISIBLE_YET', item.orderNo, true);
        return;
      }
      const upsert = await this.store.upsertExternalOrder({ adminId: job.adminId, accountId: job.accountId, accountName: account.displayName, item, syncedAt: new Date().toISOString() });
      const delaySeconds = job.dueAt ? 0 : Math.max(0, Math.min(3600, await this.options.resolveDelaySeconds?.(job.adminId, upsert.order) ?? 0));
      const initialDueAt = new Date(Math.max(Date.now(), Date.parse(job.receivedAt) + delaySeconds * 1000)).toISOString();
      const persistedDueAt = await this.store.setPaymentEventDue({ id: job.id, ownerToken: job.ownerToken!, dueAt: initialDueAt });
      if (!persistedDueAt) return;
      const dueAt = Date.parse(persistedDueAt);
      if (Number.isFinite(dueAt) && dueAt > Date.now()) {
        await this.store.finishPaymentEvent({ id: job.id, ownerToken: job.ownerToken!, status: 'pending', orderNo: item.orderNo, nextAttemptAt: new Date(dueAt).toISOString() });
        return;
      }
      const requestId = `payment-event:${job.id}`;
      const result = await this.processOrder({ adminId: job.adminId, accountId: job.accountId, items: [upsert.order], requestId, traceId: requestId });
      const paid = result.results.find((entry) => entry.trigger === 'payment_paid');
      if (!paid || paid.status === 'failed' || paid.status === 'unknown' || (paid.status === 'manual_review' && paid.reason?.startsWith('AUTHORITATIVE_ORDER_')) || (paid.status === 'skipped' && paid.reason === 'PRODUCT_LINK_MISSING')) { await this.defer(job, paid?.reason ?? 'AUTOMATION_NOT_RUN', item.orderNo, paid?.reason?.startsWith('AUTHORITATIVE_ORDER_') ?? false); return; }
      const needsHuman = paid.status === 'manual_review' || paid.status === 'blocked';
      await this.store.finishPaymentEvent({ id: job.id, ownerToken: job.ownerToken!, status: needsHuman ? 'manual_review' : 'completed', orderNo: item.orderNo, lastError: paid.reason });
      const order = upsert.order;
      const amount = `¥${(order.amountMinor / 100).toFixed(2)}`;
      const summary = `商品：${order.itemTitle}${order.skuSpec ? `（${order.skuSpec}）` : ''}\n金额：${amount}\n买家：${order.buyerNickname || order.buyerName}\n订单：${order.orderNo}`;
      notify(needsHuman
        ? { kind: 'order_manual_review', title: '订单已付款，需要人工处理', body: `${summary}\n原因：${paid.reason ?? paid.status}`, accountId: job.accountId, accountLabel: account.displayName, dedupeKey: `order-review:${order.orderNo}` }
        : { kind: 'order_paid', title: '新订单已付款', body: `${summary}\n自动化：${paid.status}${paid.reason ? `（${paid.reason}）` : ''}`, accountId: job.accountId, accountLabel: account.displayName, dedupeKey: `order-paid:${order.orderNo}` });
    } catch (error) {
      await this.defer(job, error instanceof Error ? error.message : 'PAYMENT_EVENT_FAILED');
    }
  }

  private scanAccountForExactOrders(adminId: string, accountId: string): Promise<{ kind: 'complete' | 'handoff' } | { kind: 'retry'; error: string }> {
    const existing = this.targetedScans.get(accountId);
    if (existing) return existing;
    const scan = this.runAccountScan(adminId, accountId).finally(() => { this.targetedScans.delete(accountId); });
    this.targetedScans.set(accountId, scan);
    return scan;
  }

  private async runAccountScan(adminId: string, accountId: string): Promise<{ kind: 'complete' | 'handoff' } | { kind: 'retry'; error: string }> {
    for (let page = 1; page <= 100; page += 1) {
      const result = await this.mtop.fetchOrderCandidates(adminId, accountId, undefined, page);
      if (!result.success) return { kind: 'retry', error: result.errorCode ?? 'ORDER_LOOKUP_FAILED' };
      for (const item of result.items) {
        if (item.paymentStatus !== 'paid' || item.deliveryStatus !== 'pending' || item.orderStatus !== 'open' || item.afterSalesStatus !== 'none' || item.buyerId === 'unknown-buyer' || item.itemId === 'unknown-item') continue;
        await this.store.enqueuePaymentEvent({ adminId, accountId, eventRef: `reconcile:${item.orderNo}`, orderNo: item.orderNo, buyerRef: item.buyerId, itemRef: item.itemId, conversationRef: item.conversationId ?? '', receivedAt: new Date().toISOString() });
      }
      if (!result.hasMore) return { kind: 'complete' };
    }
    if ((this.reconcileCursors.get(accountId) ?? 0) < 101) this.reconcileCursors.set(accountId, 101);
    return { kind: 'handoff' };
  }

  private async defer(job: PaymentEventJob, reason: string, orderNo?: string, observationFailure = false): Promise<void> {
    const awaitAccount = observationFailure || reason === 'ACCOUNT_NOT_READY' || /ACCOUNT_VALIDATION_REQUIRED|SESSION_EXPIRED|CREDENTIAL_MISSING|MTOP_RETRY_EXHAUSTED|XIANYU_IM_NOT_READY/.test(reason);
    const exhausted = !awaitAccount && job.attemptCount >= 12;
    const backoffMs = awaitAccount ? 60_000 : Math.min(60_000, 1_000 * (2 ** Math.min(job.attemptCount - 1, 6)));
    await this.store.finishPaymentEvent({ id: job.id, ownerToken: job.ownerToken!, status: exhausted ? 'manual_review' : orderNo || job.orderNo ? 'pending' : 'resolve_pending', orderNo, nextAttemptAt: new Date(Date.now() + backoffMs).toISOString(), lastError: reason.slice(0, 160) });
  }
}

function isTerminalOrder(order: Pick<OrderRecord, 'deliveryStatus' | 'orderStatus' | 'paymentStatus' | 'afterSalesStatus'>): boolean {
  return order.deliveryStatus === 'delivered' || ['cancelled', 'completed', 'closed', 'failed'].includes(order.orderStatus) || order.paymentStatus === 'closed' || order.afterSalesStatus !== 'none';
}

function matchingCandidates(job: PaymentEventJob, page: XianyuOrdersPageResult): XianyuOrderItem[] {
  return page.items.filter((item) => {
    return item.orderNo === job.orderNo && item.buyerId !== 'unknown-buyer' && item.itemId !== 'unknown-item';
  });
}
