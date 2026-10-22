import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryStore } from '../src/store-memory.js';
import { ProductListingService } from '../src/product-listing.js';

async function setup() {
  const store = new MemoryStore();
  const admin = await store.createAdmin({ email: `listing-${Math.random().toString(16).slice(2)}@example.com`, passwordHash: 'hash', displayName: 'Listing' });
  const account = await store.createAccount({ adminId: admin.id, platform: 'xianyu', sellerRef: 'seller-1' });
  const published = await store.createProduct({ adminId: admin.id, accountId: account.id, externalProductRef: 'item-1', title: '在售商品', status: 'published' });
  const other = await store.createProduct({ adminId: admin.id, accountId: account.id, externalProductRef: 'item-2', title: '第二件', status: 'published' });
  const draft = await store.createProduct({ adminId: admin.id, accountId: account.id, title: '本地草稿' });
  const audits: string[] = [];
  const audit = async (input: { action: string }) => { audits.push(input.action); return 'audit-1'; };
  return { store, admin, account, published, other, draft, audits, audit };
}

test('batch offline calls Xianyu once with every published item and records the listing state locally', async () => {
  const { store, admin, account, published, other, draft, audits, audit } = await setup();
  const calls: string[][] = [];
  const xianyu = {
    offlineItems: async (_a: string, _b: string, ids: string[]) => { calls.push(ids); return { status: 'succeeded' as const, cookieHeader: '', items: ids.map((itemId) => ({ itemId, success: itemId !== 'item-2' })) }; },
    deleteItem: async () => { throw new Error('should not delete'); },
  };
  const service = new ProductListingService(store, xianyu, audit);
  const result = await service.offline({ adminId: admin.id, accountId: account.id, productIds: [published.id, other.id, draft.id, 'missing'], requestId: 'r', traceId: 't' });

  assert.deepEqual(calls, [['item-1', 'item-2']]);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 3);
  const byId = Object.fromEntries(result.items.map((item) => [item.productId, item]));
  assert.equal(byId[published.id]?.status, 'succeeded');
  assert.equal(byId[other.id]?.status, 'failed', 'per-item rejection is surfaced');
  assert.equal(byId[draft.id]?.errorCode, 'NOT_PUBLISHED');
  assert.equal(byId.missing?.errorCode, 'NOT_FOUND');
  const stored = await store.getProduct(admin.id, published.id);
  assert.equal((stored?.attributes?.listing as { state?: string })?.state, 'offline');
  const untouched = await store.getProduct(admin.id, other.id);
  assert.equal((untouched?.attributes?.listing as { state?: string } | undefined)?.state, undefined);
  assert.deepEqual(audits, ['product.offline']);
});

test('batch delete removes each item individually and keeps unknown outcomes unmarked', async () => {
  const { store, admin, account, published, other, draft, audit } = await setup();
  const xianyu = {
    offlineItems: async () => { throw new Error('should not offline'); },
    deleteItem: async (_a: string, _b: string, itemId: string) => itemId === 'item-1'
      ? { status: 'succeeded' as const, cookieHeader: '' }
      : { status: 'unknown' as const, errorCode: 'MTOP_RETRY_EXHAUSTED', message: 'fetch failed', cookieHeader: '' },
  };
  const service = new ProductListingService(store, xianyu, audit);
  const result = await service.delete({ adminId: admin.id, accountId: account.id, productIds: [published.id, other.id], requestId: 'r', traceId: 't' });
  assert.equal(result.succeeded, 1);
  assert.equal(result.items.find((item) => item.productId === other.id)?.status, 'unknown');
  const deleted = await store.getProduct(admin.id, published.id);
  assert.equal((deleted?.attributes?.listing as { state?: string })?.state, 'deleted');
  assert.equal(deleted?.status, 'archived', 'a deleted listing is archived locally');
  const untouched = await store.getProduct(admin.id, other.id);
  assert.equal((untouched?.attributes?.listing as { state?: string } | undefined)?.state, undefined);
  assert.equal(untouched?.status, 'published');

  const defaultList = await store.listProducts(admin.id, { accountId: account.id });
  assert.deepEqual(defaultList.items.map((item) => item.id).sort(), [other.id, draft.id].sort(), 'archived products leave the default list');
  const archivedList = await store.listProducts(admin.id, { accountId: account.id, status: 'archived' });
  assert.deepEqual(archivedList.items.map((item) => item.id), [published.id], 'the 已归档 filter still shows them');
  const everything = await store.listProducts(admin.id, { accountId: account.id, includeArchived: true });
  assert.equal(everything.total, 3);
});

test('a re-synced item that is live on Xianyu again loses its stale listing marker', async () => {
  const { store, admin, account, published } = await setup();
  const marked = await store.updateProduct({ adminId: admin.id, productId: published.id, expectedConfigVersion: published.configVersion, patch: { attributes: { listing: { state: 'offline', source: 'fishagent' } } } });
  assert.equal((marked?.attributes?.listing as { state?: string })?.state, 'offline');
  const upserted = await store.upsertExternalProduct({ adminId: admin.id, accountId: account.id, syncedAt: new Date().toISOString(), item: { externalProductRef: 'item-1', title: '在售商品', imageUrls: [], attributes: {}, sourcePayloadDigest: 'd1' } });
  assert.equal(upserted.action, 'updated');
  assert.equal(upserted.product.attributes?.listing, undefined, 'the live listing clears offline/deleted markers');
  assert.equal(upserted.product.status, 'published');
});

test('a product that is already deleted cannot be taken offline or deleted again', async () => {
  const { store, admin, account, published, audit } = await setup();
  const calls: string[] = [];
  const xianyu = {
    offlineItems: async (_a: string, _b: string, ids: string[]) => { calls.push(`offline:${ids.join(',')}`); return { status: 'succeeded' as const, cookieHeader: '', items: ids.map((itemId) => ({ itemId, success: true })) }; },
    deleteItem: async (_a: string, _b: string, itemId: string) => { calls.push(`delete:${itemId}`); return { status: 'succeeded' as const, cookieHeader: '' }; },
  };
  const service = new ProductListingService(store, xianyu, audit);
  await service.delete({ adminId: admin.id, accountId: account.id, productIds: [published.id], requestId: 'r', traceId: 't' });
  assert.deepEqual(calls, ['delete:item-1']);

  const offlineAgain = await service.offline({ adminId: admin.id, accountId: account.id, productIds: [published.id], requestId: 'r', traceId: 't' });
  assert.equal(offlineAgain.items[0]?.errorCode, 'ALREADY_DELETED');
  const deleteAgain = await service.delete({ adminId: admin.id, accountId: account.id, productIds: [published.id], requestId: 'r', traceId: 't' });
  assert.equal(deleteAgain.items[0]?.errorCode, 'ALREADY_DELETED');
  assert.deepEqual(calls, ['delete:item-1'], 'Xianyu is not called again for a deleted product');
  const stored = await store.getProduct(admin.id, published.id);
  assert.equal(stored?.status, 'archived');
  assert.equal((stored?.attributes?.listing as { state?: string })?.state, 'deleted', 'the deleted marker is never overwritten by offline');
});

test('listing actions reject empty input and foreign accounts', async () => {
  const { store, admin, account, audit } = await setup();
  const service = new ProductListingService(store, { offlineItems: async () => { throw new Error('x'); }, deleteItem: async () => { throw new Error('x'); } }, audit);
  await assert.rejects(service.offline({ adminId: admin.id, accountId: account.id, productIds: [], requestId: 'r', traceId: 't' }), /productIds/);
  const stranger = await store.createAdmin({ email: `stranger-${Math.random().toString(16).slice(2)}@example.com`, passwordHash: 'hash', displayName: 'S' });
  await assert.rejects(service.offline({ adminId: stranger.id, accountId: account.id, productIds: ['x'], requestId: 'r', traceId: 't' }), /scope/);
});
