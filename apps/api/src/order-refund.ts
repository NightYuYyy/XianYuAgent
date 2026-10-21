import type { AfterSalesStatus, DeliveryRecord, OrderRecord, Store } from './domain.js';
import { notify } from './notifier.js';

/**
 * 退款处理。
 *
 * 闲鱼的退款本身由平台裁决，卖家端能做的是：第一时间知道（推送通知），以及把
 * 已经发出去的虚拟卡券作废（调用卖家自己的注销接口）。这里在订单售后状态进入
 * 退款流程时触发一次：推送通知 + 可选的注销 Webhook，带上该订单的交付记录。
 *
 * 配置：
 *   REFUND_REVOKE_WEBHOOK_URL     收到退款申请时 POST 的地址（可选）
 *   REFUND_REVOKE_WEBHOOK_SECRET  以 Bearer 形式放在 Authorization 头（可选）
 */
export const REFUND_IN_PROGRESS: ReadonlySet<AfterSalesStatus> = new Set(['requested', 'refunding']);

export function isRefundTransition(previous: Pick<OrderRecord, 'afterSalesStatus'> | undefined, next: Pick<OrderRecord, 'afterSalesStatus'>): boolean {
  if (!REFUND_IN_PROGRESS.has(next.afterSalesStatus)) return false;
  return !previous || !REFUND_IN_PROGRESS.has(previous.afterSalesStatus);
}

export interface RefundRevokePayload {
  event: 'order_refund_requested';
  orderNo: string;
  accountId: string;
  accountName?: string;
  buyerId: string;
  buyerName: string;
  itemId: string;
  itemTitle: string;
  skuSpec?: string;
  amountMinor: number;
  afterSalesStatus: AfterSalesStatus;
  deliveries: Array<{ id: string; status: string; couponItemId?: string; deliveredAt?: string; externalRef?: string }>;
  at: string;
}

export interface OrderRefundHandlerOptions {
  webhookUrl?: string;
  webhookSecret?: string;
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, 'info' | 'warn'>;
  now?: () => number;
  /** Repeats for the same order inside this window are ignored (process-local). */
  dedupeMs?: number;
}

export class OrderRefundHandler {
  private readonly webhookUrl?: string;
  private readonly webhookSecret?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Pick<Console, 'info' | 'warn'>;
  private readonly now: () => number;
  private readonly dedupeMs: number;
  private readonly seen = new Map<string, number>();

  constructor(private readonly store: Pick<Store, 'listDeliveryRecords'>, options: OrderRefundHandlerOptions = {}) {
    this.webhookUrl = options.webhookUrl?.trim() || undefined;
    this.webhookSecret = options.webhookSecret?.trim() || undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger ?? console;
    this.now = options.now ?? Date.now;
    this.dedupeMs = Math.max(0, options.dedupeMs ?? 24 * 60 * 60_000);
  }

  get webhookEnabled(): boolean {
    return Boolean(this.webhookUrl);
  }

  /** Never throws: a failing webhook must not break the order refresh that detected the refund. */
  async handleRefundRequested(input: { adminId: string; accountId: string; order: OrderRecord }): Promise<{ notified: boolean; webhook: 'sent' | 'failed' | 'disabled' | 'duplicate' }> {
    const { adminId, accountId, order } = input;
    const key = `${accountId}\u0000${order.orderNo}`;
    const last = this.seen.get(key);
    const now = this.now();
    if (last !== undefined && now - last < this.dedupeMs) return { notified: false, webhook: 'duplicate' };
    this.seen.set(key, now);
    if (this.seen.size > 5_000) for (const [k, at] of this.seen) if (now - at >= this.dedupeMs) this.seen.delete(k);

    let deliveries: DeliveryRecord[] = [];
    try {
      deliveries = await this.store.listDeliveryRecords(adminId, { accountId, orderNo: order.orderNo });
    } catch (error) {
      this.logger.warn(JSON.stringify({ component: 'order-refund', event: 'delivery_lookup_failed', orderNo: order.orderNo, reason: error instanceof Error ? error.message : String(error) }));
    }
    const delivered = deliveries.filter((record) => record.status === 'delivered' || record.deliveredAt);
    const amount = `¥${(order.amountMinor / 100).toFixed(2)}`;
    notify({
      kind: 'order_refund_requested',
      title: '买家发起退款',
      body: `商品：${order.itemTitle}${order.skuSpec ? `（${order.skuSpec}）` : ''}\n金额：${amount}\n买家：${order.buyerNickname || order.buyerName}\n订单：${order.orderNo}\n已交付记录：${delivered.length} 条${this.webhookUrl ? '\n已通知注销接口' : ''}`,
      accountId,
      accountLabel: order.accountName,
      dedupeKey: `refund:${order.orderNo}`,
    });
    this.logger.info(JSON.stringify({ component: 'order-refund', event: 'refund_requested', adminId, accountId, orderNo: order.orderNo, afterSalesStatus: order.afterSalesStatus, deliveries: delivered.length }));

    if (!this.webhookUrl) return { notified: true, webhook: 'disabled' };
    const payload: RefundRevokePayload = {
      event: 'order_refund_requested',
      orderNo: order.orderNo,
      accountId,
      accountName: order.accountName,
      buyerId: order.buyerId,
      buyerName: order.buyerNickname || order.buyerName,
      itemId: order.itemId,
      itemTitle: order.itemTitle,
      skuSpec: order.skuSpec,
      amountMinor: order.amountMinor,
      afterSalesStatus: order.afterSalesStatus,
      deliveries: delivered.map((record) => ({ id: record.id, status: record.status, couponItemId: record.couponItemId, deliveredAt: record.deliveredAt, externalRef: record.externalRef })),
      at: new Date(now).toISOString(),
    };
    try {
      const response = await this.fetchImpl(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.webhookSecret ? { authorization: `Bearer ${this.webhookSecret}` } : {}) },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      await response.arrayBuffer().catch(() => undefined);
      this.logger.info(JSON.stringify({ component: 'order-refund', event: 'revoke_webhook_sent', orderNo: order.orderNo }));
      return { notified: true, webhook: 'sent' };
    } catch (error) {
      this.logger.warn(JSON.stringify({ component: 'order-refund', event: 'revoke_webhook_failed', orderNo: order.orderNo, reason: error instanceof Error ? error.message : String(error) }));
      return { notified: true, webhook: 'failed' };
    }
  }
}

export function createOrderRefundHandlerFromEnv(store: Pick<Store, 'listDeliveryRecords'>, env: NodeJS.ProcessEnv = process.env): OrderRefundHandler {
  return new OrderRefundHandler(store, { webhookUrl: env.REFUND_REVOKE_WEBHOOK_URL, webhookSecret: env.REFUND_REVOKE_WEBHOOK_SECRET });
}
