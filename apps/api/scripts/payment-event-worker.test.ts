import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryStore } from '../src/store-memory.js';
import { PaymentEventWorker } from '../src/payment-event-worker.js';
import { extractTrustedOrderNo, isTrustedPaidEvent, trustedPaymentOccurredAt } from '../src/payment-event-parser.js';
import type { XianyuOrderItem } from '../src/domain.js';
import type { XianyuImMessageEvent } from '../src/xianyu-im.js';

const ORDER_NO = '2503688126356636370';

function order(overrides: Partial<XianyuOrderItem> = {}): XianyuOrderItem {
  return { orderNo: ORDER_NO, buyerId: 'buyer-1', buyerName: 'Buyer', itemId: 'item-1', itemTitle: 'Product', amountMinor: 1000, paymentStatus: 'paid', orderStatus: 'open', deliveryStatus: 'pending', afterSalesStatus: 'none', deliveryType: 'coupon_only', createdAt: new Date().toISOString(), ...overrides };
}

function event(raw?: Record<string, unknown>): XianyuImMessageEvent {
  return { accountId: 'account-1', externalConversationRef: 'conversation-1', externalMessageRef: 'message-1', senderRef: 'buyer-1', itemRef: 'item-1', direction: 'inbound', bodyType: 'text', bodyText: '我已付款，等待卖家发货', platformSystemMessage: true, occurredAt: new Date().toISOString(), raw };
}

test('trusted paid card extracts only one structured order identifier', () => {
  const raw = { '1': { '6': { '3': { '5': JSON.stringify({ dxCard: { item: { main: { targetUrl: `fleamarket://order_detail?id=${ORDER_NO}&role=seller` } } } }) } } } };
  assert.equal(isTrustedPaidEvent(event(raw)), true);
  assert.equal(extractTrustedOrderNo(raw), ORDER_NO);
  assert.equal(extractTrustedOrderNo({ targetUrl: `fleamarket://order_detail?id=${ORDER_NO}`, nested: { bizOrderId: '2503688126356636371' } }), undefined);
  assert.equal(isTrustedPaidEvent({ ...event(raw), platformSystemMessage: false }), false);
});

test('trusted payment time prefers platform occurrence and rejects future or invalid timestamps', () => {
  const receivedAt = '2026-10-15T08:00:00.000Z';
  const occurredAt = '2026-10-15T06:00:00.000Z';
  assert.equal(trustedPaymentOccurredAt({ ...event(), occurredAt, receivedAt }, Date.parse(receivedAt)), occurredAt);
  assert.equal(trustedPaymentOccurredAt({ ...event(), occurredAt: '2099-01-01T00:00:00.000Z', receivedAt }, Date.parse(receivedAt)), receivedAt);
  assert.equal(trustedPaymentOccurredAt({ ...event(), occurredAt, receivedAt, riskFlags: ['source_timestamp_invalid'] }, Date.parse(receivedAt)), receivedAt);
});

test('trusted order number dispatches despite system sender metadata and order-level dedup', async () => {
  const store = new MemoryStore();
  const admin = await store.createAdmin({ email: 'payment-direct@example.com', passwordHash: 'hash', displayName: 'Direct' });
  const account = await store.createAccount({ adminId: admin.id, platform: 'xianyu', sellerRef: 'seller-direct' });
  await store.updateAccount(admin.id, account.id, { status: 'connected' });
  const product = await store.createProduct({ adminId: admin.id, accountId: account.id, externalProductRef: 'item-1', title: 'Product', status: 'published' });
  const calls: Array<string | undefined> = [];
  const delivered: string[] = [];
  const mtop = { fetchOrderCandidates: async (_adminId: string, _accountId: string, orderNo?: string) => {
    calls.push(orderNo);
    return { success: true, accountInvalid: false, cookieHeader: '', items: [order()], pageNumber: 1, pageSize: 10, hasMore: false };
  } };
  const worker = new PaymentEventWorker(store, mtop, async (input) => {
    assert.equal(input.items[0]?.productId, product.id);
    delivered.push(input.items[0]!.orderNo);
    return { processed: 1, results: [{ trigger: 'payment_paid', orderNo: ORDER_NO, status: 'succeeded' }] };
  }, { workerId: 'test-direct' });
  const input = { adminId: admin.id, accountId: account.id, eventRef: 'paid-card-1', orderNo: ORDER_NO, buyerRef: 'system-not-buyer', itemRef: 'unrelated-conversation-item', conversationRef: 'system-conversation', receivedAt: new Date().toISOString() };
  const first = await store.enqueuePaymentEvent(input);
  assert.equal((await store.enqueuePaymentEvent({ ...input, eventRef: `reconcile:${ORDER_NO}`, buyerRef: 'buyer-1', itemRef: 'item-1', conversationRef: '' })).id, first.id);
  assert.equal(await worker.pollOnce(), 1);
  assert.deepEqual(calls, [ORDER_NO]);
  assert.deepEqual(delivered, [ORDER_NO]);
  assert.equal(await worker.pollOnce(), 0);
});

test('missing-order IM event only enqueues exact-order jobs, including multiple buyer-item matches', async () => {
  const store = new MemoryStore();
  const admin = await store.createAdmin({ email: 'payment-resolve@example.com', passwordHash: 'hash', displayName: 'Resolve' });
  const account = await store.createAccount({ adminId: admin.id, platform: 'xianyu', sellerRef: 'seller-resolve' });
  await store.updateAccount(admin.id, account.id, { status: 'connected' });
  const candidates = [order(), order({ orderNo: '2503688126356636371' })];
  let dispatches = 0;
  const worker = new PaymentEventWorker(store, { fetchOrderCandidates: async () => ({ success: true, accountInvalid: false, cookieHeader: '', items: candidates, pageNumber: 1, pageSize: 100, hasMore: false }) }, async () => {
    dispatches += 1;
    return { processed: 1, results: [{ trigger: 'payment_paid', status: 'succeeded' }] };
  }, { workerId: 'test-resolve', resolveDelaySeconds: async () => 60 });
  const input = { adminId: admin.id, accountId: account.id, eventRef: 'paid-no-id', buyerRef: 'buyer-1', itemRef: 'item-1', conversationRef: 'conversation-1', receivedAt: new Date().toISOString() };
  await store.enqueuePaymentEvent(input);
  assert.equal(await worker.pollOnce(), 1);
  assert.equal(dispatches, 0);
  const source = await store.enqueuePaymentEvent(input);
  assert.equal(source.status, 'completed');
  assert.equal(source.orderNo, undefined);
  assert.equal(source.lastError, 'ORDER_ID_UNAVAILABLE_SCAN_COMPLETE');
  assert.equal((await store.enqueuePaymentEvent({ ...input, eventRef: `reconcile:${ORDER_NO}`, orderNo: ORDER_NO })).status, 'pending');
  assert.equal((await store.enqueuePaymentEvent({ ...input, eventRef: 'reconcile:2503688126356636371', orderNo: '2503688126356636371' })).status, 'pending');
});

test('expired claim can be reclaimed and stale owner cannot finish it', async () => {
  const store = new MemoryStore();
  const admin = await store.createAdmin({ email: 'payment-lease@example.com', passwordHash: 'hash', displayName: 'Lease' });
  const account = await store.createAccount({ adminId: admin.id, platform: 'xianyu', sellerRef: 'seller-lease' });
  await store.enqueuePaymentEvent({ adminId: admin.id, accountId: account.id, eventRef: 'paid-lease', orderNo: ORDER_NO, buyerRef: 'buyer-1', conversationRef: 'conversation-1', receivedAt: new Date().toISOString() });
  const first = (await store.claimPaymentEvents({ workerId: 'one', limit: 1, leaseMs: 1 }))[0]!;
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = (await store.claimPaymentEvents({ workerId: 'two', limit: 1, leaseMs: 1000 }))[0]!;
  assert.notEqual(second.ownerToken, first.ownerToken);
  assert.equal(await store.finishPaymentEvent({ id: first.id, ownerToken: first.ownerToken!, status: 'completed' }), false);
  assert.equal(await store.finishPaymentEvent({ id: second.id, ownerToken: second.ownerToken!, status: 'completed' }), true);
});

test('missing-order event scans later pages and delivers only through the exact-order job', async () => {
  const store = new MemoryStore();
  const admin = await store.createAdmin({ email: 'payment-pages@example.com', passwordHash: 'hash', displayName: 'Pages' });
  const account = await store.createAccount({ adminId: admin.id, platform: 'xianyu', sellerRef: 'seller-pages' });
  await store.updateAccount(admin.id, account.id, { status: 'connected' });
  await store.createProduct({ adminId: admin.id, accountId: account.id, externalProductRef: 'item-1', title: 'Product', status: 'published' });
  const pages: number[] = [];
  const delivered: string[] = [];
  const worker = new PaymentEventWorker(store, { fetchOrderCandidates: async (_adminId, _accountId, _orderNo, page = 1) => {
    pages.push(page);
    return { success: true, accountInvalid: false, cookieHeader: '', items: page === 2 ? [order()] : [order({ orderNo: '2503688126356636399', buyerId: 'other', paymentStatus: 'unpaid' })], pageNumber: page, pageSize: 100, hasMore: page === 1 };
  } }, async (input) => {
    delivered.push(input.items[0]!.orderNo);
    return { processed: 1, results: [{ trigger: 'payment_paid', status: 'succeeded' }] };
  }, { workerId: 'test-pages' });
  await store.enqueuePaymentEvent({ adminId: admin.id, accountId: account.id, eventRef: 'paid-page-2', buyerRef: 'buyer-1', itemRef: 'item-1', conversationRef: 'conversation-1', receivedAt: new Date().toISOString() });
  await worker.pollOnce();
  assert.deepEqual(pages, [1, 2]);
  assert.deepEqual(delivered, []);
  assert.equal(await worker.pollOnce(), 1);
  assert.deepEqual(delivered, [ORDER_NO]);
});

test('refresh job without conversation reference accepts authoritative matching order', async () => {
  const store = new MemoryStore();
  const admin = await store.createAdmin({ email: 'payment-refresh@example.com', passwordHash: 'hash', displayName: 'Refresh' });
  const account = await store.createAccount({ adminId: admin.id, platform: 'xianyu', sellerRef: 'seller-refresh' });
  await store.updateAccount(admin.id, account.id, { status: 'connected' });
  await store.createProduct({ adminId: admin.id, accountId: account.id, externalProductRef: 'item-1', title: 'Product', status: 'published' });
  let dispatched = 0;
  const worker = new PaymentEventWorker(store, { fetchOrderCandidates: async () => ({ success: true, accountInvalid: false, cookieHeader: '', items: [order({ conversationId: 'remote-conversation' })], pageNumber: 1, pageSize: 10, hasMore: false }) }, async () => {
    dispatched += 1;
    return { processed: 1, results: [{ trigger: 'payment_paid', status: 'succeeded' }] };
  }, { workerId: 'test-refresh' });
  await store.enqueuePaymentEvent({ adminId: admin.id, accountId: account.id, eventRef: `reconcile:${ORDER_NO}`, orderNo: ORDER_NO, buyerRef: 'buyer-1', itemRef: 'item-1', conversationRef: '', receivedAt: new Date().toISOString() });
  await worker.pollOnce();
  assert.equal(dispatched, 1);
});

test('scheduled delivery due time remains fixed after rule delay changes', async () => {
  const store = new MemoryStore();
  const admin = await store.createAdmin({ email: 'payment-due@example.com', passwordHash: 'hash', displayName: 'Due' });
  const account = await store.createAccount({ adminId: admin.id, platform: 'xianyu', sellerRef: 'seller-due' });
  await store.updateAccount(admin.id, account.id, { status: 'connected' });
  await store.createProduct({ adminId: admin.id, accountId: account.id, externalProductRef: 'item-1', title: 'Product', status: 'published' });
  let delay = 10;
  let resolves = 0;
  let deliveries = 0;
  const worker = new PaymentEventWorker(store, { fetchOrderCandidates: async () => ({ success: true, accountInvalid: false, cookieHeader: '', items: [order()], pageNumber: 1, pageSize: 10, hasMore: false }) }, async () => {
    deliveries += 1;
    return { processed: 1, results: [{ trigger: 'payment_paid', status: 'succeeded' }] };
  }, { workerId: 'test-due', resolveDelaySeconds: async () => { resolves += 1; return delay; } });
  await store.enqueuePaymentEvent({ adminId: admin.id, accountId: account.id, eventRef: 'paid-due', orderNo: ORDER_NO, buyerRef: 'buyer-1', itemRef: 'item-1', conversationRef: '', receivedAt: new Date().toISOString() });
  await worker.pollOnce();
  assert.equal(deliveries, 0);
  delay = 600;
  const realNow = Date.now;
  Date.now = () => realNow() + 11_000;
  try {
    await worker.pollOnce();
    assert.equal(deliveries, 1);
    assert.equal(resolves, 1);
  } finally { Date.now = realNow; }
});

test('recovered historical payment whose configured delay has elapsed dispatches immediately', async () => {
  const store = new MemoryStore();
  const admin = await store.createAdmin({ email: 'payment-history@example.com', passwordHash: 'hash', displayName: 'History' });
  const account = await store.createAccount({ adminId: admin.id, platform: 'xianyu', sellerRef: 'seller-history' });
  await store.updateAccount(admin.id, account.id, { status: 'connected' });
  await store.createProduct({ adminId: admin.id, accountId: account.id, externalProductRef: 'item-1', title: 'Product', status: 'published' });
  let delivered = 0;
  const worker = new PaymentEventWorker(store, { fetchOrderCandidates: async () => ({ success: true, accountInvalid: false, cookieHeader: '', items: [order()], pageNumber: 1, pageSize: 10, hasMore: false }) }, async () => {
    delivered += 1;
    return { processed: 1, results: [{ trigger: 'payment_paid', orderNo: ORDER_NO, status: 'succeeded' }] };
  }, { workerId: 'test-history', resolveDelaySeconds: async () => 600 });
  const receivedAt = trustedPaymentOccurredAt({ ...event(), occurredAt: new Date(Date.now() - 3_600_000).toISOString(), receivedAt: new Date().toISOString() });
  await store.enqueuePaymentEvent({ adminId: admin.id, accountId: account.id, eventRef: 'paid-history', orderNo: ORDER_NO, buyerRef: 'buyer-1', itemRef: 'item-1', conversationRef: '', receivedAt });
  assert.equal(await worker.pollOnce(), 1);
  assert.equal(delivered, 1);
});

test('temporary IM outage remains retryable beyond twelve attempts and wakes on reconnect', async () => {
  const store = new MemoryStore();
  const admin = await store.createAdmin({ email: 'payment-im-recovery@example.com', passwordHash: 'hash', displayName: 'Recovery' });
  const account = await store.createAccount({ adminId: admin.id, platform: 'xianyu', sellerRef: 'seller-im-recovery' });
  await store.updateAccount(admin.id, account.id, { status: 'connected' });
  await store.createProduct({ adminId: admin.id, accountId: account.id, externalProductRef: 'item-1', title: 'Product', status: 'published' });
  let ready = false;
  let dispatched = 0;
  const worker = new PaymentEventWorker(store, { fetchOrderCandidates: async () => ({ success: true, accountInvalid: false, cookieHeader: '', items: [order()], pageNumber: 1, pageSize: 10, hasMore: false }) }, async () => {
    dispatched += 1;
    return { processed: 1, results: [{ trigger: 'payment_paid', orderNo: ORDER_NO, status: ready ? 'succeeded' : 'unknown', reason: ready ? undefined : 'XIANYU_IM_NOT_READY' }] };
  }, { workerId: 'test-im-recovery' });
  const input = { adminId: admin.id, accountId: account.id, eventRef: 'paid-im-recovery', orderNo: ORDER_NO, buyerRef: 'buyer-1', itemRef: 'item-1', conversationRef: '', receivedAt: new Date().toISOString() };
  const job = await store.enqueuePaymentEvent(input);
  for (let attempt = 0; attempt < 13; attempt += 1) {
    if (attempt > 0) {
      await store.setAccountTransport({ adminId: admin.id, accountId: account.id, status: 'disconnected' });
      await store.setAccountTransport({ adminId: admin.id, accountId: account.id, status: 'connected' });
    }
    assert.equal(await worker.pollOnce(), 1);
  }
  assert.equal((await store.enqueuePaymentEvent(input)).status, 'pending');
  ready = true;
  await store.setAccountTransport({ adminId: admin.id, accountId: account.id, status: 'disconnected' });
  await store.setAccountTransport({ adminId: admin.id, accountId: account.id, status: 'connected' });
  assert.equal(await worker.pollOnce(), 1);
  assert.equal((await store.enqueuePaymentEvent(input)).status, 'completed');
  assert.equal(dispatched, 14);
  assert.equal((await store.enqueuePaymentEvent(input)).id, job.id);
});

test('temporary order lookup failure remains retryable beyond twelve attempts', async () => {
  const store = new MemoryStore();
  const admin = await store.createAdmin({ email: 'payment-lookup-recovery@example.com', passwordHash: 'hash', displayName: 'Recovery' });
  const account = await store.createAccount({ adminId: admin.id, platform: 'xianyu', sellerRef: 'seller-lookup-recovery' });
  await store.updateAccount(admin.id, account.id, { status: 'connected' });
  const input = { adminId: admin.id, accountId: account.id, eventRef: 'paid-lookup-recovery', orderNo: ORDER_NO, buyerRef: 'buyer-1', itemRef: 'item-1', conversationRef: '', receivedAt: new Date().toISOString() };
  await store.enqueuePaymentEvent(input);
  const worker = new PaymentEventWorker(store, { fetchOrderCandidates: async () => ({ success: false, accountInvalid: false, cookieHeader: '', errorCode: 'NETWORK_TIMEOUT', items: [], pageNumber: 1, pageSize: 10, hasMore: false }) }, async () => ({ processed: 0, results: [] }), { workerId: 'test-lookup-recovery' });
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    for (let attempt = 0; attempt < 13; attempt += 1) {
      assert.equal(await worker.pollOnce(), 1);
      clock += 61_000;
    }
    const job = await store.enqueuePaymentEvent(input);
    assert.equal(job.status, 'pending');
    assert.equal(job.attemptCount, 13);
  } finally { Date.now = realNow; }
});

test('payment card before order-list convergence retries until paid state appears', async () => {
  const store = new MemoryStore();
  const admin = await store.createAdmin({ email: 'payment-convergence@example.com', passwordHash: 'hash', displayName: 'Convergence' });
  const account = await store.createAccount({ adminId: admin.id, platform: 'xianyu', sellerRef: 'seller-convergence' });
  await store.updateAccount(admin.id, account.id, { status: 'connected' });
  await store.createProduct({ adminId: admin.id, accountId: account.id, externalProductRef: 'item-1', title: 'Product', status: 'published' });
  let visiblePayment: XianyuOrderItem['paymentStatus'] = 'unpaid';
  let delivered = 0;
  const worker = new PaymentEventWorker(store, { fetchOrderCandidates: async () => ({ success: true, accountInvalid: false, cookieHeader: '', items: [order({ paymentStatus: visiblePayment })], pageNumber: 1, pageSize: 10, hasMore: false }) }, async () => {
    delivered += 1;
    return { processed: 1, results: [{ trigger: 'payment_paid', orderNo: ORDER_NO, status: 'succeeded' }] };
  }, { workerId: 'test-convergence' });
  const input = { adminId: admin.id, accountId: account.id, eventRef: 'paid-before-list', orderNo: ORDER_NO, buyerRef: 'buyer-1', itemRef: 'item-1', conversationRef: '', receivedAt: new Date().toISOString() };
  await store.enqueuePaymentEvent(input);
  assert.equal(await worker.pollOnce(), 1);
  assert.equal((await store.enqueuePaymentEvent(input)).status, 'pending');
  assert.equal(delivered, 0);
  visiblePayment = 'paid';
  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  try { assert.equal(await worker.pollOnce(), 1); }
  finally { Date.now = realNow; }
  assert.equal(delivered, 1);
  assert.equal((await store.enqueuePaymentEvent(input)).status, 'completed');
});

for (const terminal of [
  { name: 'delivered', state: { deliveryStatus: 'delivered' as const } },
  { name: 'closed', state: { orderStatus: 'closed' as const, paymentStatus: 'closed' as const } },
]) {
  test(`missing-order historical ${terminal.name} event never binds a local terminal order`, async () => {
    const store = new MemoryStore();
    const admin = await store.createAdmin({ email: `terminal-${terminal.name}@example.com`, passwordHash: 'hash', displayName: 'Terminal' });
    const account = await store.createAccount({ adminId: admin.id, platform: 'xianyu', sellerRef: `seller-${terminal.name}` });
    await store.updateAccount(admin.id, account.id, { status: 'connected' });
    const conversation = await store.createConversation({ adminId: admin.id, accountId: account.id, buyerRef: 'buyer-1', itemRef: 'item-1', externalConversationRef: 'external-conversation' });
    const createdAt = new Date(Date.now() - 30_000).toISOString();
    await store.createOrder({ adminId: admin.id, order: { ...order({ ...terminal.state, createdAt }), accountId: account.id, conversationId: conversation.id, source: 'xianyu' } });
    const calls: Array<string | undefined> = [];
    let dispatches = 0;
    const worker = new PaymentEventWorker(store, { fetchOrderCandidates: async (_adminId, _accountId, orderNo?: string) => {
      calls.push(orderNo);
      return { success: true, accountInvalid: false, cookieHeader: '', items: orderNo ? [order({ ...terminal.state, createdAt })] : [], pageNumber: 1, pageSize: 100, hasMore: false };
    } }, async () => { dispatches += 1; return { processed: 0, results: [] }; }, { workerId: `terminal-${terminal.name}` });
    const input = { adminId: admin.id, accountId: account.id, eventRef: `terminal-${terminal.name}`, buyerRef: 'buyer-1', itemRef: 'item-1', conversationRef: 'external-conversation', receivedAt: new Date().toISOString() };
    await store.enqueuePaymentEvent(input);
    assert.equal(await worker.pollOnce(), 1);
    assert.deepEqual(calls, [undefined]);
    assert.equal(dispatches, 0);
    assert.equal((await store.enqueuePaymentEvent(input)).status, 'completed');
    assert.equal((await store.enqueuePaymentEvent(input)).orderNo, undefined);
    assert.equal((await store.enqueuePaymentEvent(input)).lastError, 'ORDER_ID_UNAVAILABLE_SCAN_COMPLETE');
    assert.equal(await worker.pollOnce(), 0);
  });
}

for (const scenario of ['future_local', 'stale', 'ambiguous', 'active_competitor'] as const) {
  test(`missing-order event ignores ${scenario} local order evidence`, async () => {
    const store = new MemoryStore();
    const admin = await store.createAdmin({ email: `terminal-${scenario}@example.com`, passwordHash: 'hash', displayName: 'Terminal' });
    const account = await store.createAccount({ adminId: admin.id, platform: 'xianyu', sellerRef: `seller-${scenario}` });
    await store.updateAccount(admin.id, account.id, { status: 'connected' });
    const conversation = await store.createConversation({ adminId: admin.id, accountId: account.id, buyerRef: 'buyer-1', itemRef: 'item-1', externalConversationRef: 'external-conversation' });
    const createdAt = new Date(Date.now() + (scenario === 'future_local' ? 60_000 : scenario === 'stale' ? -86_400_000 : -30_000)).toISOString();
    await store.createOrder({ adminId: admin.id, order: { ...order({ deliveryStatus: 'delivered', createdAt }), accountId: account.id, conversationId: conversation.id, source: 'xianyu' } });
    if (scenario === 'ambiguous' || scenario === 'active_competitor') await store.createOrder({ adminId: admin.id, order: { ...order({ orderNo: '2503688126356636371', deliveryStatus: scenario === 'active_competitor' ? 'pending' : 'delivered', createdAt }), accountId: account.id, conversationId: conversation.id, source: 'xianyu' } });
    const calls: Array<string | undefined> = [];
    const worker = new PaymentEventWorker(store, { fetchOrderCandidates: async (_adminId, _accountId, orderNo?: string) => {
      calls.push(orderNo);
      return { success: true, accountInvalid: false, cookieHeader: '', items: orderNo ? [order({ deliveryStatus: 'delivered', createdAt })] : [], pageNumber: 1, pageSize: 100, hasMore: false };
    } }, async () => { assert.fail('historical terminal event must not dispatch delivery'); }, { workerId: `terminal-${scenario}` });
    const input = { adminId: admin.id, accountId: account.id, eventRef: `terminal-${scenario}`, buyerRef: 'buyer-1', itemRef: 'item-1', conversationRef: 'external-conversation', receivedAt: new Date().toISOString() };
    await store.enqueuePaymentEvent(input);
    assert.equal(await worker.pollOnce(), 1);
    assert.deepEqual(calls, [undefined]);
    const job = await store.enqueuePaymentEvent(input);
    assert.equal(job.status, 'completed');
    assert.equal(job.orderNo, undefined);
  });
}

test('missing-order event does not bind a newer order even when it is the only list item', async () => {
    const store = new MemoryStore();
    const admin = await store.createAdmin({ email: 'payment-future@example.com', passwordHash: 'hash', displayName: 'Payment' });
    const account = await store.createAccount({ adminId: admin.id, platform: 'xianyu', sellerRef: 'seller-future' });
    await store.updateAccount(admin.id, account.id, { status: 'connected' });
    const receivedAt = new Date(Date.now() - 3_600_000).toISOString();
    const createdAt = new Date(Date.parse(receivedAt) + 60_000).toISOString();
    const calls: Array<string | undefined> = [];
    const worker = new PaymentEventWorker(store, { fetchOrderCandidates: async (_adminId, _accountId, orderNo?: string) => {
      calls.push(orderNo);
      return { success: true, accountInvalid: false, cookieHeader: '', items: [order({ createdAt })], pageNumber: 1, pageSize: 100, hasMore: false };
    } }, async () => { assert.fail('unrelated order must not dispatch delivery'); }, { workerId: 'payment-future' });
    const input = { adminId: admin.id, accountId: account.id, eventRef: 'payment-future', buyerRef: 'buyer-1', itemRef: 'item-1', conversationRef: 'external-conversation', receivedAt };
    await store.enqueuePaymentEvent(input);
    assert.equal(await worker.pollOnce(), 1);
    assert.deepEqual(calls, [undefined]);
    const source = await store.enqueuePaymentEvent(input);
    assert.equal(source.status, 'completed');
    assert.equal(source.orderNo, undefined);
    assert.equal((await store.enqueuePaymentEvent({ ...input, eventRef: `reconcile:${ORDER_NO}`, orderNo: ORDER_NO })).status, 'pending');
});

test('late payment is delivered through the exact-order reconciliation job', async () => {
  const store = new MemoryStore();
  const admin = await store.createAdmin({ email: 'payment-late@example.com', passwordHash: 'hash', displayName: 'Payment' });
  const account = await store.createAccount({ adminId: admin.id, platform: 'xianyu', sellerRef: 'seller-late' });
  await store.updateAccount(admin.id, account.id, { status: 'connected' });
  await store.createProduct({ adminId: admin.id, accountId: account.id, externalProductRef: 'item-1', title: 'Product', status: 'published' });
  const receivedAt = new Date().toISOString();
  const createdAt = new Date(Date.parse(receivedAt) - 3_600_000).toISOString();
  const delivered: string[] = [];
  const worker = new PaymentEventWorker(store, { fetchOrderCandidates: async () => ({ success: true, accountInvalid: false, cookieHeader: '', items: [order({ createdAt })], pageNumber: 1, pageSize: 100, hasMore: false }) }, async (input) => {
    delivered.push(input.items[0]!.orderNo);
    return { processed: 1, results: [{ trigger: 'payment_paid', orderNo: ORDER_NO, status: 'succeeded' }] };
  }, { workerId: 'payment-late' });
  const input = { adminId: admin.id, accountId: account.id, eventRef: 'payment-late', buyerRef: 'buyer-1', itemRef: 'item-1', conversationRef: 'external-conversation', receivedAt };
  await store.enqueuePaymentEvent(input);
  assert.equal(await worker.pollOnce(), 1);
  assert.deepEqual(delivered, []);
  assert.equal((await store.enqueuePaymentEvent(input)).orderNo, undefined);
  assert.equal(await worker.pollOnce(), 1);
  assert.deepEqual(delivered, [ORDER_NO]);
  assert.equal((await store.enqueuePaymentEvent({ ...input, eventRef: `reconcile:${ORDER_NO}`, orderNo: ORDER_NO })).status, 'completed');
});

test('missing platform creation time waits for exact-order reconciliation instead of guessing', async () => {
  const store = new MemoryStore();
  const admin = await store.createAdmin({ email: 'payment-no-create-time@example.com', passwordHash: 'hash', displayName: 'Payment' });
  const account = await store.createAccount({ adminId: admin.id, platform: 'xianyu', sellerRef: 'seller-no-create-time' });
  await store.updateAccount(admin.id, account.id, { status: 'connected' });
  await store.createProduct({ adminId: admin.id, accountId: account.id, externalProductRef: 'item-1', title: 'Product', status: 'published' });
  const item = order({ createdAtReliable: false });
  const delivered: string[] = [];
  const worker = new PaymentEventWorker(store, { fetchOrderCandidates: async () => ({ success: true, accountInvalid: false, cookieHeader: '', items: [item], pageNumber: 1, pageSize: 100, hasMore: false }) }, async (input) => {
    delivered.push(input.items[0]!.orderNo);
    return { processed: 1, results: [{ trigger: 'payment_paid', orderNo: ORDER_NO, status: 'succeeded' }] };
  }, { workerId: 'payment-no-create-time' });
  const input = { adminId: admin.id, accountId: account.id, eventRef: 'payment-no-create-time', buyerRef: 'buyer-1', itemRef: 'item-1', conversationRef: 'external-conversation', receivedAt: new Date(Date.now() - 60_000).toISOString() };
  await store.enqueuePaymentEvent(input);
  assert.equal(await worker.pollOnce(), 1);
  assert.deepEqual(delivered, []);
  assert.equal((await store.enqueuePaymentEvent(input)).status, 'completed');
  assert.equal(await worker.pollOnce(), 1);
  assert.deepEqual(delivered, [ORDER_NO]);
  assert.equal((await store.enqueuePaymentEvent({ ...input, eventRef: `reconcile:${ORDER_NO}`, orderNo: ORDER_NO })).status, 'completed');
});

test('no-ID event remains retryable after a failed scan and completes after recovery', async () => {
  const store = new MemoryStore();
  const admin = await store.createAdmin({ email: 'payment-scan-recovery@example.com', passwordHash: 'hash', displayName: 'Recovery' });
  const account = await store.createAccount({ adminId: admin.id, platform: 'xianyu', sellerRef: 'seller-scan-recovery' });
  await store.updateAccount(admin.id, account.id, { status: 'connected' });
  const input = { adminId: admin.id, accountId: account.id, eventRef: 'scan-recovery', buyerRef: 'buyer-1', itemRef: 'item-1', conversationRef: 'conversation-1', receivedAt: new Date().toISOString() };
  await store.enqueuePaymentEvent(input);
  let available = false;
  const worker = new PaymentEventWorker(store, { fetchOrderCandidates: async () => ({ success: available, accountInvalid: false, cookieHeader: '', errorCode: available ? undefined : 'NETWORK_TIMEOUT', items: [], pageNumber: 1, pageSize: 100, hasMore: false }) }, async () => { assert.fail('no-ID job cannot dispatch delivery'); }, { workerId: 'scan-recovery' });
  assert.equal(await worker.pollOnce(), 1);
  assert.equal((await store.enqueuePaymentEvent(input)).status, 'resolve_pending');
  available = true;
  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  try { assert.equal(await worker.pollOnce(), 1); }
  finally { Date.now = realNow; }
  const completed = await store.enqueuePaymentEvent(input);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.orderNo, undefined);
});

test('thrown no-ID scan errors do not exhaust the payment event before recovery', async () => {
  const store = new MemoryStore();
  const admin = await store.createAdmin({ email: 'payment-scan-throw@example.com', passwordHash: 'hash', displayName: 'Recovery' });
  const account = await store.createAccount({ adminId: admin.id, platform: 'xianyu', sellerRef: 'seller-scan-throw' });
  await store.updateAccount(admin.id, account.id, { status: 'connected' });
  const input = { adminId: admin.id, accountId: account.id, eventRef: 'scan-throw', buyerRef: 'buyer-1', itemRef: 'item-1', conversationRef: 'conversation-1', receivedAt: new Date().toISOString() };
  await store.enqueuePaymentEvent(input);
  let available = false;
  const worker = new PaymentEventWorker(store, { fetchOrderCandidates: async () => {
    if (!available) throw new Error('NETWORK_TIMEOUT');
    return { success: true, accountInvalid: false, cookieHeader: '', items: [], pageNumber: 1, pageSize: 100, hasMore: false };
  } }, async () => { assert.fail('no-ID job cannot dispatch delivery'); }, { workerId: 'scan-throw' });
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    for (let attempt = 0; attempt < 13; attempt += 1) {
      assert.equal(await worker.pollOnce(), 1);
      now += 61_000;
    }
    assert.equal((await store.enqueuePaymentEvent(input)).status, 'resolve_pending');
    available = true;
    assert.equal(await worker.pollOnce(), 1);
    assert.equal((await store.enqueuePaymentEvent(input)).status, 'completed');
  } finally { Date.now = realNow; }
});

test('no-ID scan hands off deep pages without repeated claims or rewinding the cursor', async () => {
  const store = new MemoryStore();
  const admin = await store.createAdmin({ email: 'payment-scan-pages@example.com', passwordHash: 'hash', displayName: 'Pages' });
  const account = await store.createAccount({ adminId: admin.id, platform: 'xianyu', sellerRef: 'seller-scan-pages' });
  await store.updateAccount(admin.id, account.id, { status: 'connected' });
  const input = { adminId: admin.id, accountId: account.id, eventRef: 'scan-pages', buyerRef: 'buyer-1', itemRef: 'item-1', conversationRef: 'conversation-1', receivedAt: new Date().toISOString() };
  await store.enqueuePaymentEvent(input);
  const pages: number[] = [];
  const worker = new PaymentEventWorker(store, { fetchOrderCandidates: async (_adminId, _accountId, _orderNo, page = 1) => {
    pages.push(page);
    return { success: true, accountInvalid: false, cookieHeader: '', items: [], pageNumber: page, pageSize: 100, hasMore: page <= 250 };
  } }, async () => { assert.fail('no-ID job cannot dispatch delivery'); }, { workerId: 'scan-pages' });
  assert.equal(await worker.pollOnce(), 1);
  assert.equal(pages.length, 100);
  assert.equal((await store.enqueuePaymentEvent(input)).status, 'completed');
  assert.equal((await store.enqueuePaymentEvent(input)).lastError, 'ORDER_ID_UNAVAILABLE_RECONCILE_HANDOFF');
  assert.equal(await worker.pollOnce(), 0);
  await worker.reconcileOnce();
  assert.equal(pages[100], 1);
  assert.equal(pages[199], 100);
  assert.equal(pages[200], 101);
  assert.equal(pages[299], 200);
  assert.equal(pages.length, 300);
  await store.enqueuePaymentEvent({ ...input, eventRef: 'scan-pages-second' });
  assert.equal(await worker.pollOnce(), 1);
  assert.equal(pages.length, 400);
  assert.equal((await store.enqueuePaymentEvent({ ...input, eventRef: 'scan-pages-second' })).lastError, 'ORDER_ID_UNAVAILABLE_RECONCILE_HANDOFF');
  await worker.reconcileOnce();
  assert.equal(pages[400], 1);
  assert.equal(pages[499], 100);
  assert.equal(pages[500], 201);
  assert.equal(pages.at(-1), 251);
  assert.equal(await worker.pollOnce(), 0);
});

test('deep-page reconciliation scans page 50 for late payment every cycle', async () => {
  const store = new MemoryStore();
  const admin = await store.createAdmin({ email: 'payment-hot-page@example.com', passwordHash: 'hash', displayName: 'Pages' });
  const account = await store.createAccount({ adminId: admin.id, platform: 'xianyu', sellerRef: 'seller-hot-page' });
  await store.updateAccount(admin.id, account.id, { status: 'connected' });
  await store.createProduct({ adminId: admin.id, accountId: account.id, externalProductRef: 'item-1', title: 'Product', status: 'published' });
  const pages: number[] = [];
  let cycle = 0;
  const delivered: string[] = [];
  const worker = new PaymentEventWorker(store, { fetchOrderCandidates: async (_adminId, _accountId, orderNo?: string, page = 1) => {
    if (orderNo) return { success: true, accountInvalid: false, cookieHeader: '', items: [order()], pageNumber: 1, pageSize: 10, hasMore: false };
    pages.push(page);
    if (page === 1) cycle += 1;
    return { success: true, accountInvalid: false, cookieHeader: '', items: page === 50 && cycle >= 2 ? [order()] : [], pageNumber: page, pageSize: 100, hasMore: page <= 250 };
  } }, async (input) => {
    delivered.push(input.items[0]!.orderNo);
    return { processed: 1, results: [{ trigger: 'payment_paid', orderNo: ORDER_NO, status: 'succeeded' }] };
  }, { workerId: 'hot-page' });
  assert.equal(await worker.reconcileOnce(), 0);
  assert.equal(pages.length, 200);
  assert.equal(await worker.reconcileOnce(), 1);
  assert.equal(pages[200], 1);
  assert.equal(pages[249], 50);
  assert.equal(pages[299], 100);
  assert.equal(pages[300], 201);
  assert.equal(pages.at(-1), 251);
  await worker.stop();
  assert.deepEqual(delivered, [ORDER_NO]);
});

test('reconciliation visits each healthy account first page before deep pagination and skips risk accounts', async () => {
  const store = new MemoryStore();
  const admin = await store.createAdmin({ email: 'payment-fair-reconcile@example.com', passwordHash: 'hash', displayName: 'Fair' });
  const first = await store.createAccount({ adminId: admin.id, platform: 'xianyu', sellerRef: 'seller-fair-one' });
  const second = await store.createAccount({ adminId: admin.id, platform: 'xianyu', sellerRef: 'seller-fair-two' });
  const risk = await store.createAccount({ adminId: admin.id, platform: 'xianyu', sellerRef: 'seller-fair-risk' });
  await store.updateAccount(admin.id, first.id, { status: 'connected' });
  await store.updateAccount(admin.id, second.id, { status: 'connected' });
  await store.recordAccountRisk({ adminId: admin.id, accountId: risk.id, code: 'RGV587', source: 'sold.orders' });
  const calls: Array<{ accountId: string; page: number }> = [];
  const worker = new PaymentEventWorker(store, { fetchOrderCandidates: async (_adminId, accountId, _orderNo, page = 1) => {
    calls.push({ accountId, page });
    return { success: true, accountInvalid: false, cookieHeader: '', items: [], pageNumber: page, pageSize: 10, hasMore: accountId === first.id && page === 1 };
  } }, async () => ({ processed: 0, results: [] }), { workerId: 'test-fair' });
  await worker.reconcileOnce();
  assert.deepEqual(calls, [{ accountId: first.id, page: 1 }, { accountId: second.id, page: 1 }, { accountId: first.id, page: 2 }]);
  assert.equal(calls.some((call) => call.accountId === risk.id), false);
});
