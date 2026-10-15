import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryStore } from '../src/store-memory.js';

test('delivery guard blocks cross-path replay and quarantines uncertain inventory', async () => {
  const store = new MemoryStore();
  const admin = await store.createAdmin({ email: 'delivery-guard@example.com', passwordHash: 'hash', displayName: 'Guard' });
  const account = await store.createAccount({ adminId: admin.id, platform: 'xianyu', sellerRef: 'seller-guard' });
  const batch = await store.createCouponBatch({ adminId: admin.id, accountId: account.id, label: 'Codes', purpose: 'text' });
  await store.importCouponItems({ adminId: admin.id, batchId: batch.id, contents: ['SECRET-1'] });
  const key = `paid_auto_delivery:${account.id}:order-1`;
  const reservation = await store.reserveCoupon({ adminId: admin.id, accountId: account.id, batchIds: [batch.id], quantity: 1, executionKey: key, purpose: 'delivery' });
  const step = { adminId: admin.id, accountId: account.id, orderNo: 'order-1', executionKey: key, stepKey: 'card-1:text:0' };
  assert.equal((await store.beginDeliverySendStep(step)).status, 'ready');
  assert.equal((await store.beginDeliverySendStep({ ...step, executionKey: `manual-delivery:${account.id}:order-1` })).status, 'blocked');
  assert.equal((await store.beginDeliverySendStep(step)).status, 'blocked', 'in-flight send outcome is unknown after restart');
  assert.equal(await store.quarantineCouponReservation({ adminId: admin.id, executionKey: key, reason: 'SEND_UNKNOWN' }), true);
  assert.equal((await store.getCouponReservation({ adminId: admin.id, reservationId: reservation.reservationId }))?.status, 'quarantined');
  await assert.rejects(() => store.releaseCouponReservation({ adminId: admin.id, reservationId: reservation.reservationId, executionKey: key, reason: 'retry' }), /QUARANTINED/);
  await assert.rejects(() => store.reserveCoupon({ adminId: admin.id, accountId: account.id, batchIds: [batch.id], quantity: 1, executionKey: key, purpose: 'delivery' }), /QUARANTINED/);
});

test('completed send step is idempotent for its owner only', async () => {
  const store = new MemoryStore();
  const admin = await store.createAdmin({ email: 'delivery-step@example.com', passwordHash: 'hash', displayName: 'Step' });
  const account = await store.createAccount({ adminId: admin.id, platform: 'xianyu', sellerRef: 'seller-step' });
  const step = { adminId: admin.id, accountId: account.id, orderNo: 'order-2', executionKey: 'auto:order-2', stepKey: 'card:text:0' };
  assert.equal((await store.beginDeliverySendStep(step)).status, 'ready');
  assert.equal(await store.completeDeliverySendStep({ ...step, externalRef: 'message-1' }), true);
  assert.deepEqual(await store.beginDeliverySendStep(step), { status: 'succeeded', externalRef: 'message-1' });
  assert.equal((await store.beginDeliverySendStep({ ...step, executionKey: 'manual:order-2' })).status, 'blocked');
});

test('reservation binding fences stock through expiry and a second order cannot acquire it', async () => {
  const store = new MemoryStore();
  const admin = await store.createAdmin({ email: 'delivery-expiry@example.com', passwordHash: 'hash', displayName: 'Expiry' });
  const account = await store.createAccount({ adminId: admin.id, platform: 'xianyu', sellerRef: 'seller-expiry' });
  const batch = await store.createCouponBatch({ adminId: admin.id, accountId: account.id, label: 'One code', purpose: 'text' });
  await store.importCouponItems({ adminId: admin.id, batchId: batch.id, contents: ['SECRET-2'] });
  const key = `paid_auto_delivery:${account.id}:order-first`;
  const reservation = await store.reserveCoupon({ adminId: admin.id, accountId: account.id, batchIds: [batch.id], quantity: 1, executionKey: key, purpose: 'delivery', leaseSeconds: 300 });
  assert.equal(await store.bindDeliveryReservation({ adminId: admin.id, accountId: account.id, orderNo: 'order-first', reservationId: reservation.reservationId, executionKey: key }), true);
  const realNow = Date.now;
  Date.now = () => realNow() + 301_000;
  try {
    assert.equal(await store.cleanupExpiredCouponReservations(), 0);
    await assert.rejects(() => store.reserveCoupon({ adminId: admin.id, accountId: account.id, batchIds: [batch.id], quantity: 1, executionKey: `paid_auto_delivery:${account.id}:order-second`, purpose: 'delivery' }), /COUPON|INSUFFICIENT|UNAVAILABLE/);
    assert.equal((await store.commitCouponReservation({ adminId: admin.id, reservationId: reservation.reservationId, executionKey: key })).status, 'committed');
  } finally { Date.now = realNow; }
});
