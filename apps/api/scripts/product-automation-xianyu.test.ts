import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryStore } from '../src/store-memory.js';
import { XianyuProductAutomationExecutionAdapter } from '../src/product-automation-xianyu.js';
import type { XianyuMtopClient } from '../src/xianyu-mtop.js';
import type { XianyuImService } from '../src/xianyu-im-service.js';
import type { OrderRecord, XianyuOrderItem } from '../src/domain.js';

function withListedOrder(order: OrderRecord, mtop: XianyuMtopClient, overrides: Partial<XianyuOrderItem> = {}): XianyuMtopClient {
  return { ...mtop, fetchOrderCandidates: async () => ({ success: true, accountInvalid: false, cookieHeader: '', items: [{ ...order, ...overrides }], pageNumber: 1, pageSize: 10, hasMore: false }) } as XianyuMtopClient;
}

function paidDetail(order: OrderRecord) {
  return { success: true, accountInvalid: false, detail: { orderNo: order.orderNo, orderStatus: '2', deliveryStatus: '2', buyerId: order.buyerId, itemId: order.itemId }, cookieHeader: '' };
}

async function setup() {
  const store = new MemoryStore();
  const admin = await store.createAdmin({ email: `live-${Math.random()}@example.com`, passwordHash: 'hash', displayName: 'Live' });
  const account = await store.createAccount({ adminId: admin.id, platform: 'xianyu', sellerRef: `seller-${Math.random()}` });
  const product = await store.createProduct({ adminId: admin.id, accountId: account.id, externalProductRef: 'item-live', title: '2026年奥维高清地图骗局', status: 'published' });
  const conversation = await store.createConversation({ adminId: admin.id, accountId: account.id, buyerRef: 'buyer-live', buyerDisplayName: '测试买家', externalConversationRef: 'cid-live@goofish' });
  const order = await store.createOrder({ adminId: admin.id, order: {
    orderNo: 'ORDER-LIVE-1', accountId: account.id, buyerId: 'buyer-live', buyerName: '测试买家', itemId: 'item-live', itemTitle: product.title,
    amountMinor: 1000, paymentStatus: 'paid', orderStatus: 'open', deliveryStatus: 'pending', afterSalesStatus: 'none', deliveryType: 'coupon_only',
    createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z', conversationId: conversation.id, productId: product.id,
  }});
  const batch = await store.createCouponBatch({ adminId: admin.id, accountId: account.id, label: 'Live Coupon', purpose: 'text' });
  await store.importCouponItems({ adminId: admin.id, batchId: batch.id, contents: ['LIVE-CODE-001'] });
  return { store, admin, account, product, conversation, order, batch };
}

test('live adapter reserves and sends the persisted coupon content through IM', async () => {
  const { store, admin, account, order, batch } = await setup();
  const sent: string[] = [];
  const fakeIm = { sendText: async (_adminId: string, _accountId: string, _conversationId: string, text: string) => { sent.push(text); return { externalMessageRef: 'im-live-1' }; } } as unknown as XianyuImService;
  const fakeMtop = { readOrderDetail: async () => paidDetail(order) } as unknown as XianyuMtopClient;
  const adapter = new XianyuProductAutomationExecutionAdapter(store, () => withListedOrder(order, fakeMtop), () => fakeIm);
  const reservation = await adapter.reserveCoupon({ adminId: admin.id, accountId: account.id, batchIds: [batch.id], quantity: 1, executionKey: 'live-send-1', purpose: 'delivery' });
  const result = await adapter.sendCoupon({ adminId: admin.id, accountId: account.id, productId: order.productId, itemId: order.itemId, itemTitle: order.itemTitle, orderNo: order.orderNo, reservationId: reservation.reservationId, executionKey: 'live-send-1', purpose: 'delivery' });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(sent, ['LIVE-CODE-001']);
  await adapter.commitCoupon({ adminId: admin.id, reservationId: reservation.reservationId, executionKey: 'live-send-1' });
  assert.equal((await store.getCouponReservation({ adminId: admin.id, reservationId: reservation.reservationId }))?.status, 'committed');
});

test('uncertain IM send keeps the reservation held for manual review', async () => {
  const { store, admin, account, order, batch } = await setup();
  const fakeIm = { sendText: async () => { throw Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }); } } as unknown as XianyuImService;
  const adapter = new XianyuProductAutomationExecutionAdapter(store, () => withListedOrder(order, { readOrderDetail: async () => paidDetail(order) } as unknown as XianyuMtopClient), () => fakeIm);
  const reservation = await adapter.reserveCoupon({ adminId: admin.id, accountId: account.id, batchIds: [batch.id], quantity: 1, executionKey: 'live-unknown-1', purpose: 'delivery' });
  const result = await adapter.sendCoupon({ adminId: admin.id, accountId: account.id, productId: order.productId, itemId: order.itemId, itemTitle: order.itemTitle, orderNo: order.orderNo, reservationId: reservation.reservationId, executionKey: 'live-unknown-1', purpose: 'delivery' });
  assert.equal(result.status, 'unknown');
  assert.equal((await store.getCouponReservation({ adminId: admin.id, reservationId: reservation.reservationId }))?.status, 'quarantined');
});

test('live adapter blocks remote shipment mutation when order detail is unavailable', async () => {
  const { store, admin, account, order } = await setup();
  let confirmed = false;
  const fakeMtop = {
    readOrderDetail: async () => ({ success: false, accountInvalid: false, errorCode: 'MTOP_RETRY_EXHAUSTED', message: 'timeout', cookieHeader: '' }),
    confirmShipment: async () => { confirmed = true; return { status: 'succeeded', externalRef: order.orderNo }; },
  } as unknown as XianyuMtopClient;
  const adapter = new XianyuProductAutomationExecutionAdapter(store, () => withListedOrder(order, fakeMtop), () => undefined);
  const result = await adapter.confirmShipment({ adminId: admin.id, accountId: account.id, productId: order.productId, itemId: order.itemId, itemTitle: order.itemTitle, orderNo: order.orderNo, executionKey: 'live-confirm-1' });
  assert.equal(result.status, 'unknown');
  assert.equal(confirmed, false);
  assert.equal((await store.getOrder(admin.id, order.orderNo, account.id))?.deliveryStatus, 'pending');
});

test('shipment-only recovery restores the immutable no-logistics text', async () => {
  const { store, admin, account, order } = await setup();
  const executionKey = `paid_auto_delivery:${account.id}:${order.orderNo}`;
  const tradeTexts: string[] = [];
  const fakeMtop = {
    readOrderDetail: async () => paidDetail(order),
    confirmShipment: async (_adminId: string, _accountId: string, _orderNo: string, tradeText: string) => { tradeTexts.push(tradeText); return { status: 'succeeded', externalRef: order.orderNo }; },
  } as unknown as XianyuMtopClient;
  const adapter = new XianyuProductAutomationExecutionAdapter(store, () => withListedOrder(order, fakeMtop), () => undefined);
  const input = { adminId: admin.id, accountId: account.id, productId: order.productId, itemId: order.itemId, itemTitle: order.itemTitle, orderNo: order.orderNo, executionKey };
  const missing = await adapter.confirmShipment(input);
  assert.equal(missing.status, 'unknown');
  assert.deepEqual(tradeTexts, []);
  await store.saveDeliveryConfirmation({ adminId: admin.id, accountId: account.id, orderNo: order.orderNo, executionKey, noLogisticsForm: true, tradeText: 'fixed original form' });
  const recovered = await adapter.confirmShipment(input);
  assert.equal(recovered.status, 'succeeded');
  assert.deepEqual(tradeTexts, ['fixed original form']);
});

test('live adapter infers unpaid payment from orderStatus when detail omits paymentStatus', async () => {
  const { store, admin, account, order } = await setup();
  let repriced = false;
  const fakeMtop = {
    readOrderDetail: async () => ({ success: true, accountInvalid: false, detail: { orderNo: order.orderNo, orderStatus: '待付款' }, cookieHeader: '' }),
    repriceOrder: async () => { repriced = true; return { status: 'succeeded', externalRef: order.orderNo }; },
  } as unknown as XianyuMtopClient;
  const adapter = new XianyuProductAutomationExecutionAdapter(store, () => fakeMtop, () => undefined);
  const result = await adapter.repriceOrder({ adminId: admin.id, accountId: account.id, productId: order.productId, itemId: order.itemId, itemTitle: order.itemTitle, orderNo: order.orderNo, targetPriceMinor: 777, executionKey: 'live-reprice-order-status' });
  assert.equal(result.status, 'succeeded');
  assert.equal(repriced, true);
});

test('live adapter treats numeric orderStatus 1 as unpaid', async () => {
  const { store, admin, account, order } = await setup();
  let repriced = false;
  const fakeMtop = {
    readOrderDetail: async () => ({ success: true, accountInvalid: false, detail: { orderNo: order.orderNo, orderStatus: '1', deliveryStatus: '1' }, cookieHeader: '' }),
    repriceOrder: async () => { repriced = true; return { status: 'succeeded', externalRef: order.orderNo }; },
  } as unknown as XianyuMtopClient;
  const adapter = new XianyuProductAutomationExecutionAdapter(store, () => fakeMtop, () => undefined);
  const result = await adapter.repriceOrder({ adminId: admin.id, accountId: account.id, productId: order.productId, itemId: order.itemId, itemTitle: order.itemTitle, orderNo: order.orderNo, targetPriceMinor: 777, executionKey: 'live-reprice-numeric-1' });
  assert.equal(result.status, 'succeeded');
  assert.equal(repriced, true);
});

test('live adapter skips reprice when authoritative amount already matches target', async () => {
  const { store, admin, account, order } = await setup();
  let repriced = false;
  const fakeMtop = {
    readOrderDetail: async () => ({ success: true, accountInvalid: false, detail: { orderNo: order.orderNo, orderStatus: '待付款', paymentStatus: 'unpaid', deliveryStatus: '1', amountMinor: 3000 }, cookieHeader: '' }),
    repriceOrder: async () => { repriced = true; return { status: 'succeeded', externalRef: order.orderNo }; },
  } as unknown as XianyuMtopClient;
  const adapter = new XianyuProductAutomationExecutionAdapter(store, () => fakeMtop, () => undefined);
  const result = await adapter.repriceOrder({ adminId: admin.id, accountId: account.id, productId: order.productId, itemId: order.itemId, itemTitle: order.itemTitle, orderNo: order.orderNo, targetPriceMinor: 3000, executionKey: 'live-reprice-idempotent' });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.externalRef, order.orderNo);
  assert.equal(repriced, false);
});

test('live adapter does not reserve coupon while IM is unavailable', async () => {
  const { store, admin, account, order, batch } = await setup();
  const fakeIm = { isReady: async () => false } as unknown as XianyuImService;
  const adapter = new XianyuProductAutomationExecutionAdapter(store, () => ({} as XianyuMtopClient), () => fakeIm);
  await assert.rejects(() => adapter.reserveCoupon({ adminId: admin.id, accountId: account.id, batchIds: [batch.id], quantity: 1, executionKey: 'live-reserve-not-ready', purpose: 'delivery' }), /XIANYU_IM_NOT_READY/);
  assert.equal((await store.getCouponReservation({ adminId: admin.id, reservationId: 'missing' }))?.status, undefined);
});

test('live adapter maps numeric status 1 to unpaid and pending in readOrder', async () => {
  const { store, admin, account, order } = await setup();
  const fakeMtop = {
    readOrderDetail: async () => ({ success: true, accountInvalid: false, detail: { orderNo: order.orderNo, orderStatus: '1', deliveryStatus: '1' }, cookieHeader: '' }),
  } as unknown as XianyuMtopClient;
  const adapter = new XianyuProductAutomationExecutionAdapter(store, () => withListedOrder(order, fakeMtop, { paymentStatus: 'unpaid' }), () => undefined);
  const result = await adapter.readOrder({ adminId: admin.id, accountId: account.id, productId: order.productId, itemId: order.itemId, itemTitle: order.itemTitle, orderNo: order.orderNo });
  assert.equal(result?.paymentStatus, 'unpaid');
  assert.equal(result?.deliveryStatus, 'pending');
});

test('readOrder rejects a closed detail when the order list is stale and still open', async () => {
  const { store, admin, account, order } = await setup();
  const fakeMtop = {
    readOrderDetail: async () => ({ success: true, detail: { orderNo: order.orderNo, orderStatus: 'closed', paymentStatus: 'paid', deliveryStatus: 'pending' } }),
  } as unknown as XianyuMtopClient;
  const adapter = new XianyuProductAutomationExecutionAdapter(store, () => withListedOrder(order, fakeMtop), () => undefined);
  assert.equal(await adapter.readOrder({ adminId: admin.id, accountId: account.id, orderNo: order.orderNo }), undefined);
});

test('treats numeric order status 4 as already delivered', async () => {
  const { store, admin, account, order } = await setup();
  let confirmed = false;
  const fakeMtop = {
    readOrderDetail: async () => ({ success: true, accountInvalid: false, detail: { orderNo: order.orderNo, orderStatus: '4', deliveryStatus: '4' }, cookieHeader: '' }),
    confirmShipment: async () => { confirmed = true; return { status: 'succeeded', externalRef: order.orderNo }; },
  } as unknown as XianyuMtopClient;
  const adapter = new XianyuProductAutomationExecutionAdapter(store, () => withListedOrder(order, fakeMtop, { orderStatus: 'completed', deliveryStatus: 'delivered' }), () => undefined);
  const result = await adapter.confirmShipment({ adminId: admin.id, accountId: account.id, productId: order.productId, itemId: order.itemId, itemTitle: order.itemTitle, orderNo: order.orderNo, executionKey: 'live-confirm-numeric-4' });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.externalRef, order.orderNo);
  assert.equal(confirmed, false);
  assert.equal((await store.getOrder(admin.id, order.orderNo, account.id))?.deliveryStatus, 'delivered');
});

test('treats numeric order status 2 as pending and confirms shipment', async () => {
  const { store, admin, account, order } = await setup();
  let confirmed = false;
  const fakeMtop = {
    readOrderDetail: async () => paidDetail(order),
    confirmShipment: async () => { confirmed = true; return { status: 'succeeded', externalRef: order.orderNo }; },
  } as unknown as XianyuMtopClient;
  const adapter = new XianyuProductAutomationExecutionAdapter(store, () => withListedOrder(order, fakeMtop), () => undefined);
  const result = await adapter.confirmShipment({ adminId: admin.id, accountId: account.id, productId: order.productId, itemId: order.itemId, itemTitle: order.itemTitle, orderNo: order.orderNo, executionKey: 'live-confirm-numeric-2' });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.externalRef, order.orderNo);
  assert.equal(confirmed, true);
  assert.equal((await store.getOrder(admin.id, order.orderNo, account.id))?.deliveryStatus, 'delivered');
});

test('treats numeric order status 3 as already shipped', async () => {
  const { store, admin, account, order } = await setup();
  let confirmed = false;
  const fakeMtop = {
    readOrderDetail: async () => ({ success: true, accountInvalid: false, detail: { orderNo: order.orderNo, orderStatus: '3', deliveryStatus: '3' }, cookieHeader: '' }),
    confirmShipment: async () => { confirmed = true; return { status: 'succeeded', externalRef: order.orderNo }; },
  } as unknown as XianyuMtopClient;
  const adapter = new XianyuProductAutomationExecutionAdapter(store, () => withListedOrder(order, fakeMtop, { deliveryStatus: 'delivered' }), () => undefined);
  const result = await adapter.confirmShipment({ adminId: admin.id, accountId: account.id, productId: order.productId, itemId: order.itemId, itemTitle: order.itemTitle, orderNo: order.orderNo, executionKey: 'live-confirm-numeric-3' });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.externalRef, order.orderNo);
  assert.equal(confirmed, false);
  assert.equal((await store.getOrder(admin.id, order.orderNo, account.id))?.deliveryStatus, 'delivered');
});

test('treats ORDER_ALREADY_DELIVERY from the shipment mutation as idempotent success', async () => {
  const { store, admin, account, order } = await setup();
  let confirmed = false;
  const fakeMtop = {
    readOrderDetail: async () => paidDetail(order),
    confirmShipment: async () => { confirmed = true; return { status: 'failed', errorCode: 'ORDER_ALREADY_DELIVERY', message: '订单已发货', externalRef: order.orderNo }; },
  } as unknown as XianyuMtopClient;
  const adapter = new XianyuProductAutomationExecutionAdapter(store, () => withListedOrder(order, fakeMtop), () => undefined);
  const result = await adapter.confirmShipment({ adminId: admin.id, accountId: account.id, productId: order.productId, itemId: order.itemId, itemTitle: order.itemTitle, orderNo: order.orderNo, executionKey: 'live-confirm-already-delivered' });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.externalRef, order.orderNo);
  assert.equal(confirmed, true);
  assert.equal((await store.getOrder(admin.id, order.orderNo, account.id))?.deliveryStatus, 'delivered');
});

test('returns unknown when remote shipment succeeds but local delivery status persistence fails', async () => {
  const { store, admin, account, order } = await setup();
  let confirmed = false;
  const failingStore = store as MemoryStore & { markOrderDelivered: MemoryStore['markOrderDelivered'] };
  failingStore.markOrderDelivered = async () => { throw new Error('database unavailable'); };
  const fakeMtop = {
    readOrderDetail: async () => paidDetail(order),
    confirmShipment: async () => { confirmed = true; return { status: 'succeeded', externalRef: order.orderNo }; },
  } as unknown as XianyuMtopClient;
  const adapter = new XianyuProductAutomationExecutionAdapter(failingStore, () => withListedOrder(order, fakeMtop), () => undefined);
  const result = await adapter.confirmShipment({ adminId: admin.id, accountId: account.id, productId: order.productId, itemId: order.itemId, itemTitle: order.itemTitle, orderNo: order.orderNo, executionKey: 'live-confirm-local-persist-failure' });
  assert.equal(result.status, 'unknown');
  assert.equal(result.errorCode, 'LOCAL_ORDER_STATUS_PERSIST_FAILED');
  assert.equal(confirmed, true);
  assert.equal((await store.getOrder(admin.id, order.orderNo, account.id))?.deliveryStatus, 'pending');
});
