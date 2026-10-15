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
    const active: Array<{ adminId: string; accountId: string; page: number; startedAt: number }> = [];
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
          active.push({ adminId, accountId: account.id, page: 1, startedAt: Date.now() });
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
            if (!result.success) continue;
            for (const item of result.items) {
              if (item.paymentStatus !== 'paid' || item.deliveryStatus !== 'pending' || item.orderStatus !== 'open' || item.afterSalesStatus !== 'none' || item.buyerId === 'unknown-buyer' || item.itemId === 'unknown-item') continue;
              await this.store.enqueuePaymentEvent({ adminId: account.adminId, accountId: account.accountId, eventRef: `reconcile:${item.orderNo}`, orderNo: item.orderNo, buyerRef: item.buyerId, itemRef: item.itemId, conversationRef: item.conversationId ?? '', receivedAt: new Date().toISOString() });
              queued += 1;
            }
            if (result.hasMore && account.page < 100) active.push({ ...account, page: account.page + 1 });
            else {
              if (result.hasMore) this.options.onError?.({ scope: 'payment_reconcile_truncated', accountId: account.accountId });
              console.info(JSON.stringify({ component: 'payment-reconcile', event: 'account_scan', accountId: account.accountId, pages: account.page, durationMs: Date.now() - account.startedAt }));
            }
          } catch (error) { this.options.onError?.({ scope: 'payment_reconcile', accountId: account.accountId, error }); }
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
      const conversation = job.conversationRef ? await this.store.findConversationByExternalRef(job.adminId, job.accountId, job.conversationRef) : undefined;
      let item: XianyuOrderItem | undefined;
      if (job.orderNo) {
        const targeted = await this.mtop.fetchOrderCandidates(job.adminId, job.accountId, job.orderNo);
        if (!targeted.success) { await this.defer(job, targeted.errorCode ?? 'ORDER_LOOKUP_FAILED', undefined, true); return; }
        item = matchingCandidates(job, targeted, conversation?.id, true)[0];
      }
      if (!item) {
        const matches: XianyuOrderItem[] = [];
        let complete = false;
        for (let orderPage = 1; orderPage <= 100; orderPage += 1) {
          const page = await this.mtop.fetchOrderCandidates(job.adminId, job.accountId, undefined, orderPage);
          if (!page.success) { await this.defer(job, page.errorCode ?? 'ORDER_LOOKUP_FAILED', undefined, true); return; }
          matches.push(...matchingCandidates(job, page, conversation?.id, Boolean(job.orderNo)));
          if (!page.hasMore) { complete = true; break; }
        }
        if (!complete) { await this.defer(job, 'ORDER_SCAN_TRUNCATED', undefined, true); return; }
        item = matches.length === 1 ? matches[0] : undefined;
      }
      if (!item) { await this.defer(job, 'ORDER_NOT_VISIBLE_OR_AMBIGUOUS', undefined, true); return; }
      if (item.deliveryStatus === 'delivered' || ['cancelled', 'completed', 'closed', 'failed'].includes(item.orderStatus) || item.paymentStatus === 'closed' || item.afterSalesStatus !== 'none') {
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
      await this.store.finishPaymentEvent({ id: job.id, ownerToken: job.ownerToken!, status: paid.status === 'manual_review' || paid.status === 'blocked' ? 'manual_review' : 'completed', orderNo: item.orderNo, lastError: paid.reason });
    } catch (error) {
      await this.defer(job, error instanceof Error ? error.message : 'PAYMENT_EVENT_FAILED');
    }
  }

  private async defer(job: PaymentEventJob, reason: string, orderNo?: string, observationFailure = false): Promise<void> {
    const awaitAccount = observationFailure || reason === 'ACCOUNT_NOT_READY' || /ACCOUNT_VALIDATION_REQUIRED|SESSION_EXPIRED|CREDENTIAL_MISSING|MTOP_RETRY_EXHAUSTED|XIANYU_IM_NOT_READY/.test(reason);
    const exhausted = !awaitAccount && job.attemptCount >= 12;
    const backoffMs = awaitAccount ? 60_000 : Math.min(60_000, 1_000 * (2 ** Math.min(job.attemptCount - 1, 6)));
    await this.store.finishPaymentEvent({ id: job.id, ownerToken: job.ownerToken!, status: exhausted ? 'manual_review' : orderNo || job.orderNo ? 'pending' : 'resolve_pending', orderNo, nextAttemptAt: new Date(Date.now() + backoffMs).toISOString(), lastError: reason.slice(0, 160) });
  }
}

function matchingCandidates(job: PaymentEventJob, page: XianyuOrdersPageResult, conversationId: string | undefined, requireOrderNo: boolean): XianyuOrderItem[] {
  return page.items.filter((item) => {
    if (requireOrderNo) return item.orderNo === job.orderNo && item.buyerId !== 'unknown-buyer' && item.itemId !== 'unknown-item';
    if (item.buyerId !== job.buyerRef) return false;
    if (job.itemRef && item.itemId !== job.itemRef) return false;
    if (job.conversationRef && item.conversationId && item.conversationId !== job.conversationRef && item.conversationId !== conversationId) return false;
    if (!requireOrderNo && !job.itemRef && !job.conversationRef) return false;
    return true;
  });
}
