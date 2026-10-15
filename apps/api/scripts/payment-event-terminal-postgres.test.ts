import assert from 'node:assert/strict';
import test from 'node:test';
import { PaymentEventWorker } from '../src/payment-event-worker.js';
import { PostgresStore } from '../src/store-postgres.js';
import type { XianyuOrderItem } from '../src/domain.js';

const DATABASE_URL = 'postgres://xianyu:xianyu_dev_only@127.0.0.1:5432/xianyu_agent';

test('Postgres acknowledges a historical no-ID event after a complete account scan without binding an order', async () => {
  const store = new PostgresStore(DATABASE_URL);
  const admin = await store.createAdmin({ email: `payment-terminal-${crypto.randomUUID()}@example.com`, passwordHash: 'hash', displayName: 'Terminal' });
  const account = await store.createAccount({ adminId: admin.id, platform: 'xianyu', sellerRef: `terminal-${crypto.randomUUID()}` });
  try {
    await store.updateAccount(admin.id, account.id, { status: 'connected' });
    const conversation = await store.upsertExternalConversation({ adminId: admin.id, accountId: account.id, externalConversationRef: 'remote-conversation', buyerRef: 'buyer-1', itemRef: 'item-1' });
    const orderNo = `terminal-${crypto.randomUUID()}`;
    const createdAt = new Date(Date.now() - 30_000).toISOString();
    const item: XianyuOrderItem = { orderNo, buyerId: 'buyer-1', buyerName: 'Buyer', itemId: 'item-1', itemTitle: 'Product', amountMinor: 1000, paymentStatus: 'paid', orderStatus: 'open', deliveryStatus: 'delivered', afterSalesStatus: 'none', deliveryType: 'coupon_only', createdAt, conversationId: conversation.id, sourcePayloadDigest: 'terminal-test' };
    await store.upsertExternalOrder({ adminId: admin.id, accountId: account.id, item, syncedAt: new Date().toISOString() });
    const input = { adminId: admin.id, accountId: account.id, eventRef: `payment-${crypto.randomUUID()}`, buyerRef: 'buyer-1', itemRef: 'item-1', conversationRef: 'remote-conversation', receivedAt: new Date().toISOString() };
    const job = await store.enqueuePaymentEvent(input);
    const claimPaymentEvents = store.claimPaymentEvents.bind(store);
    store.claimPaymentEvents = (request) => claimPaymentEvents({ ...request, accountId: account.id });
    const calls: Array<string | undefined> = [];
    const worker = new PaymentEventWorker(store, { fetchOrderCandidates: async (_adminId, _accountId, targetedOrderNo?: string) => {
      calls.push(targetedOrderNo);
      return { success: true, accountInvalid: false, cookieHeader: '', items: targetedOrderNo === orderNo ? [item] : [], pageNumber: 1, pageSize: 100, hasMore: false };
    } }, async () => { assert.fail('historical terminal order must not dispatch delivery'); }, { workerId: 'terminal-postgres-test' });
    assert.equal(await worker.pollOnce(), 1);
    assert.deepEqual(calls, [undefined]);
    const persisted = await store.pool.query('select status,order_no,last_error from orders.payment_event_jobs where id=$1', [job.id]);
    assert.deepEqual(persisted.rows[0], { status: 'completed', order_no: null, last_error: 'ORDER_ID_UNAVAILABLE_SCAN_COMPLETE' });
    assert.equal(await worker.pollOnce(), 0);
  } finally {
    await store.pool.query('delete from orders.payment_event_jobs where account_id=$1', [account.id]);
    await store.pool.query('delete from orders.orders where account_id=$1', [account.id]);
    await store.pool.query('delete from messages.conversations where account_id=$1', [account.id]);
    await store.pool.query('delete from auth.account_scopes where account_id=$1', [account.id]);
    await store.pool.query('delete from accounts.accounts where id=$1', [account.id]);
    await store.pool.query('delete from auth.admins where id=$1', [admin.id]);
    await store.close();
  }
});
