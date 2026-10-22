import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryStore } from '../src/store-memory.js';
import { ProductSyncService, isXianyuItemDeletedError } from '../src/services.js';
import type { XianyuMtopClient } from '../src/xianyu-mtop.js';
import type { XianyuProductItem } from '../src/domain.js';

function item(ref: string, title: string): XianyuProductItem {
  // xianyuUpdatedAt is set so the sync does not call fetchItemDetail just to enrich the timestamp; every detail call in these tests is a reconciliation probe.
  return { externalProductRef: ref, title, imageUrls: [], attributes: {}, sourcePayloadDigest: `digest-${ref}`, xianyuUpdatedAt: '2026-10-20T00:00:00.000Z' };
}

const DELETED_MESSAGE = 'FAIL_BIZ_ITEM_DEL_NOT_FOUND::您要看的宝贝不存在或已被删除啦!';

async function setup() {
  const store = new MemoryStore();
  const admin = await store.createAdmin({ email: `sync-${Math.random().toString(16).slice(2)}@example.com`, passwordHash: 'hash', displayName: 'Sync' });
  const account = await store.createAccount({ adminId: admin.id, platform: 'xianyu', sellerRef: 'seller-1' });
  const syncedAt = new Date().toISOString();
  // Three items came from an earlier sync; the app later deleted one and took one offline.
  const live = (await store.upsertExternalProduct({ adminId: admin.id, accountId: account.id, syncedAt, item: item('live-1', '仍在售') })).product;
  const deleted = (await store.upsertExternalProduct({ adminId: admin.id, accountId: account.id, syncedAt, item: item('gone-1', 'App 里删掉的') })).product;
  const offline = (await store.upsertExternalProduct({ adminId: admin.id, accountId: account.id, syncedAt, item: item('off-1', 'App 里下架的') })).product;
  const flaky = (await store.upsertExternalProduct({ adminId: admin.id, accountId: account.id, syncedAt, item: item('flaky-1', '详情接口抖动') })).product;
  const draft = await store.createProduct({ adminId: admin.id, accountId: account.id, title: '本地草稿', externalProductRef: undefined });
  const audits: string[] = [];
  const audit = async (input: { action: string }) => { audits.push(input.action); return 'audit-1'; };
  return { store, admin, account, live, deleted, offline, flaky, draft, audits, audit };
}

function fakeXianyu(options: { items: XianyuProductItem[]; hasMore?: boolean; detail: Record<string, { success: boolean; errorCode?: string; message?: string; accountInvalid?: boolean }> }): { client: XianyuMtopClient; detailCalls: string[] } {
  const detailCalls: string[] = [];
  const client = {
    async fetchItemsAll() {
      return { pages: [{ success: true, accountInvalid: false, cookieHeader: '', items: options.items, hasMore: options.hasMore ?? false, pageNumber: 1, pageSize: 20 }], items: options.items, hasMore: options.hasMore ?? false };
    },
    async fetchItemDetail(_admin: string, _account: string, ref: string | number) {
      detailCalls.push(String(ref));
      const outcome = options.detail[String(ref)] ?? { success: true };
      return { success: outcome.success, accountInvalid: outcome.accountInvalid ?? false, errorCode: outcome.errorCode, message: outcome.message, cookieHeader: '', summary: { xianyuUpdatedAt: '2026-10-22T00:00:00.000Z' } };
    },
  } as unknown as XianyuMtopClient;
  return { client, detailCalls };
}

test('a complete sync archives items Xianyu reports as deleted and marks missing-but-readable items offline', async () => {
  const { store, admin, account, live, deleted, offline, flaky, draft, audits, audit } = await setup();
  const { client, detailCalls } = fakeXianyu({
    items: [item('live-1', '仍在售')],
    detail: {
      'gone-1': { success: false, errorCode: 'MTOP_BUSINESS_ERROR', message: DELETED_MESSAGE },
      'off-1': { success: true },
      'flaky-1': { success: false, errorCode: 'MTOP_RETRY_EXHAUSTED', message: 'fetch failed' },
    },
  });
  const service = new ProductSyncService(store, client, audit);
  const result = await service.sync({ adminId: admin.id, accountId: account.id, requestId: 'r', traceId: 't' });

  assert.equal(result.archivedCount, 1);
  assert.equal(result.offlineCount, 1);
  assert.deepEqual(detailCalls.sort(), ['flaky-1', 'gone-1', 'off-1'], 'only products missing from the listing are probed');

  const archived = await store.getProduct(admin.id, deleted.id);
  assert.equal(archived?.status, 'archived');
  assert.deepEqual((archived?.attributes?.listing as { state?: string; source?: string }), { state: 'deleted', source: 'sync', updatedAt: (archived?.attributes?.listing as { updatedAt: string }).updatedAt });

  const offlined = await store.getProduct(admin.id, offline.id);
  assert.equal(offlined?.status, 'published');
  assert.equal((offlined?.attributes?.listing as { state?: string })?.state, 'offline');

  const untouched = await store.getProduct(admin.id, flaky.id);
  assert.equal(untouched?.status, 'published');
  assert.equal(untouched?.attributes?.listing, undefined, 'a transient detail failure never archives a listing');

  assert.equal((await store.getProduct(admin.id, live.id))?.status, 'published');
  assert.equal((await store.getProduct(admin.id, draft.id))?.status, 'draft');

  const visible = await store.listProducts(admin.id, { accountId: account.id });
  assert.ok(!visible.items.some((product) => product.id === deleted.id), 'archived products leave the default list');
  assert.deepEqual(audits, ['product.sync.completed']);
});

test('a truncated listing never reconciles, and an offline item that comes back is cleared', async () => {
  const { store, admin, account, deleted, offline, audit } = await setup();
  const truncated = fakeXianyu({ items: [item('live-1', '仍在售')], hasMore: true, detail: { 'gone-1': { success: false, message: DELETED_MESSAGE } } });
  const first = await new ProductSyncService(store, truncated.client, audit).sync({ adminId: admin.id, accountId: account.id, maxPages: 1, requestId: 'r', traceId: 't' });
  assert.equal(first.hasMore, true);
  assert.equal(first.archivedCount, 0);
  assert.deepEqual(truncated.detailCalls, [], 'missing items are not probed when the listing is incomplete');
  assert.equal((await store.getProduct(admin.id, deleted.id))?.status, 'published');

  const marked = await store.getProduct(admin.id, offline.id);
  await store.updateProduct({ adminId: admin.id, productId: offline.id, expectedConfigVersion: marked!.configVersion, patch: { attributes: { ...marked!.attributes, listing: { state: 'offline', source: 'sync' } } } });
  // Everything is listed again, including the item whose detail probe was flaky last time: nothing is missing, so nothing is marked.
  const relisted = fakeXianyu({ items: [item('live-1', '仍在售'), item('off-1', 'App 里下架的'), item('gone-1', 'App 里删掉的'), item('flaky-1', '详情接口抖动')], detail: {} });
  const second = await new ProductSyncService(store, relisted.client, audit).sync({ adminId: admin.id, accountId: account.id, requestId: 'r', traceId: 't' });
  assert.equal(second.archivedCount, 0);
  assert.equal(second.offlineCount, 0);
  assert.equal((await store.getProduct(admin.id, offline.id))?.attributes?.listing, undefined, 'a live listing clears the offline marker');
});

test('an invalid credential stops reconciliation before anything is archived', async () => {
  const { store, admin, account, deleted, audit } = await setup();
  const { client } = fakeXianyu({ items: [item('live-1', '仍在售')], detail: { 'gone-1': { success: false, accountInvalid: true, errorCode: 'FAIL_SYS_SESSION_EXPIRED' }, 'off-1': { success: false, accountInvalid: true }, 'flaky-1': { success: false, accountInvalid: true } } });
  const result = await new ProductSyncService(store, client, audit).sync({ adminId: admin.id, accountId: account.id, requestId: 'r', traceId: 't' });
  assert.equal(result.archivedCount, 0);
  assert.equal((await store.getProduct(admin.id, deleted.id))?.status, 'published');
});

test('isXianyuItemDeletedError recognises the mtop deletion answer only', () => {
  assert.equal(isXianyuItemDeletedError('MTOP_BUSINESS_ERROR', DELETED_MESSAGE), true);
  assert.equal(isXianyuItemDeletedError('FAIL_BIZ_ITEM_DEL_NOT_FOUND'), true);
  assert.equal(isXianyuItemDeletedError('MTOP_RETRY_EXHAUSTED', 'fetch failed'), false);
  assert.equal(isXianyuItemDeletedError(undefined, undefined), false);
});
