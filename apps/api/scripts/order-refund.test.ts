import assert from 'node:assert/strict';
import test from 'node:test';
import type { DeliveryRecord, OrderRecord, Store } from '../src/domain.js';
import { OrderRefundHandler, isRefundTransition } from '../src/order-refund.js';
import { Notifier, configureNotifier, type NotificationEvent } from '../src/notifier.js';
import { matchesXianyuOrderStatus, parseXianyuSystemMessageKind } from '../src/xianyu-system-message.js';

const quiet = { info: () => undefined, warn: () => undefined };

function order(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: 'o-1', orderNo: '5127818256069009620', accountId: 'acc-1', accountName: '陈陈cc', buyerId: 'b-1', buyerName: '买家', itemId: 'i-1', itemTitle: 'PPT Master',
    amountMinor: 850, paymentStatus: 'paid', orderStatus: 'open', deliveryStatus: 'delivered', afterSalesStatus: 'requested', deliveryType: 'coupon_only',
    createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z', configVersion: 1, source: 'xianyu', ...overrides,
  };
}

test('refund transitions are detected only when an order enters the refund flow', () => {
  assert.equal(isRefundTransition(order({ afterSalesStatus: 'none' }), order({ afterSalesStatus: 'requested' })), true);
  assert.equal(isRefundTransition(order({ afterSalesStatus: 'none' }), order({ afterSalesStatus: 'refunding' })), true);
  assert.equal(isRefundTransition(undefined, order({ afterSalesStatus: 'refunding' })), true, 'first sight of a refunding order counts');
  assert.equal(isRefundTransition(order({ afterSalesStatus: 'requested' }), order({ afterSalesStatus: 'refunding' })), false, 'already in the flow');
  assert.equal(isRefundTransition(order({ afterSalesStatus: 'none' }), order({ afterSalesStatus: 'refunded' })), false, 'completed refunds are not a new request');
  assert.equal(isRefundTransition(order({ afterSalesStatus: 'none' }), order({ afterSalesStatus: 'none' })), false);
});

test('the platform refund-request reminder is recognised as a system message kind', () => {
  assert.equal(parseXianyuSystemMessageKind('[我发起了退款申请]'), 'refund_requested');
  assert.equal(parseXianyuSystemMessageKind('买家发起了退款申请'), 'refund_requested');
  assert.equal(parseXianyuSystemMessageKind('退款成功'), 'refund_success');
  assert.equal(parseXianyuSystemMessageKind('我想退款可以吗'), undefined, 'free text from a buyer is not a system kind');
  assert.equal(matchesXianyuOrderStatus('refund_requested', { paymentStatus: 'paid', orderStatus: 'open', deliveryStatus: 'delivered', afterSalesStatus: 'requested' }), true);
  assert.equal(matchesXianyuOrderStatus('refund_requested', { paymentStatus: 'paid', orderStatus: 'open', deliveryStatus: 'delivered', afterSalesStatus: 'none' }), false);
});

test('refund handler notifies once, posts delivered records to the revoke webhook and tolerates failures', async () => {
  const sent: NotificationEvent[] = [];
  configureNotifier(new Notifier({ channels: [{ name: 'spy', async send(event) { sent.push(event); } }], dedupeMs: 0, logger: quiet }));
  const deliveries: DeliveryRecord[] = [
    { id: 'd-1', orderId: 'o-1', orderNo: '5127818256069009620', accountId: 'acc-1', deliveryType: 'coupon_only', status: 'delivered', idempotencyScope: 's', idempotencyKey: 'k1', attempt: 1, couponItemId: 'c-1', deliveredAt: '2026-10-21T01:00:00.000Z', externalRef: 'msg-1' } as DeliveryRecord,
    { id: 'd-2', orderId: 'o-1', orderNo: '5127818256069009620', accountId: 'acc-1', deliveryType: 'coupon_only', status: 'failed', idempotencyScope: 's', idempotencyKey: 'k2', attempt: 1 } as DeliveryRecord,
  ];
  const store = { listDeliveryRecords: async () => deliveries } as unknown as Store;
  const webhookCalls: Array<{ url: string; auth?: string; body: Record<string, unknown> }> = [];
  const handler = new OrderRefundHandler(store, {
    webhookUrl: 'https://seller.example.com/revoke',
    webhookSecret: 'top-secret',
    logger: quiet,
    fetchImpl: async (input, init) => {
      const headers = init?.headers as Record<string, string>;
      webhookCalls.push({ url: String(input), auth: headers.authorization, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response('ok', { status: 200 });
    },
  });

  const first = await handler.handleRefundRequested({ adminId: 'admin', accountId: 'acc-1', order: order() });
  assert.deepEqual(first, { notified: true, webhook: 'sent' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.kind, 'order_refund_requested');
  assert.ok(sent[0]?.body?.includes('已交付记录：1 条'));
  assert.equal(webhookCalls.length, 1);
  assert.equal(webhookCalls[0]?.auth, 'Bearer top-secret');
  assert.equal((webhookCalls[0]?.body.deliveries as unknown[]).length, 1, 'only delivered records are forwarded');
  assert.equal(webhookCalls[0]?.body.orderNo, '5127818256069009620');

  const duplicate = await handler.handleRefundRequested({ adminId: 'admin', accountId: 'acc-1', order: order() });
  assert.deepEqual(duplicate, { notified: false, webhook: 'duplicate' });

  const failing = new OrderRefundHandler(store, { webhookUrl: 'https://seller.example.com/revoke', logger: quiet, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.deepEqual(await failing.handleRefundRequested({ adminId: 'admin', accountId: 'acc-1', order: order({ orderNo: 'other' }) }), { notified: true, webhook: 'failed' });

  const disabled = new OrderRefundHandler(store, { logger: quiet });
  assert.equal(disabled.webhookEnabled, false);
  assert.deepEqual(await disabled.handleRefundRequested({ adminId: 'admin', accountId: 'acc-1', order: order({ orderNo: 'third' }) }), { notified: true, webhook: 'disabled' });
  configureNotifier(new Notifier({ channels: [] }));
});
