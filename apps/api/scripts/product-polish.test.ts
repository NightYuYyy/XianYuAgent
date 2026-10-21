import assert from 'node:assert/strict';
import test from 'node:test';
import type { AccountRecord, ProductRecord, Store } from '../src/domain.js';
import { POLISH_API, POLISH_API_VERSION, ProductPolishService, ProductPolishWorker, isAlreadyPolishedMessage } from '../src/product-polish.js';

const quiet = { info: () => undefined, warn: () => undefined };

function account(id: string, overrides: Partial<AccountRecord> = {}): AccountRecord {
  return { id, platform: 'xianyu', sellerRef: `ref-${id}`, status: 'connected', createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z', autoPolish: true, ...overrides };
}

function product(id: string, accountId: string, overrides: Partial<ProductRecord> = {}): ProductRecord {
  return { id, accountId, externalProductRef: `item-${id}`, title: `商品 ${id}`, attributes: {}, configVersion: 1, status: 'published', source: 'xianyu', createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z', ...overrides };
}

function fakeStore(accounts: AccountRecord[], products: ProductRecord[]): Store {
  return {
    listAdminIds: async () => ['admin'],
    listAccounts: async (_adminId: string, query: { page?: number } = {}) => ({ items: accounts, page: query.page ?? 1, pageSize: 100, total: accounts.length, totalPages: 1 }),
    listProducts: async (_adminId: string, query: { accountId?: string; page?: number }) => {
      const items = products.filter((item) => item.accountId === query.accountId);
      return { items, page: query.page ?? 1, pageSize: 100, total: items.length, totalPages: 1 };
    },
  } as unknown as Store;
}

test('polishes every eligible product once per interval and honours platform limits', async () => {
  const calls: Array<{ accountId: string; api: string; version: string; data: Record<string, unknown> }> = [];
  const responses: Record<string, { success: boolean; accountInvalid: boolean; message?: string; errorCode?: string }> = {
    'item-a': { success: true, accountInvalid: false, message: 'SUCCESS::调用成功' },
    'item-b': { success: false, accountInvalid: false, message: 'FAIL_BIZ_今日已擦亮，明天再来' },
    'item-c': { success: false, accountInvalid: false, message: 'FAIL_BIZ_商品已下架' },
  };
  const mtop = { call: async (_adminId: string, accountId: string, api: string, version: string, data: Record<string, unknown>) => { calls.push({ accountId, api, version, data }); return { ...responses[String(data.itemId)], cookieHeader: '' }; } };
  let clock = 1_000_000;
  const store = fakeStore(
    [account('acc-1'), account('acc-off', { autoPolish: false }), account('acc-risk', { status: 'verification_required' })],
    [product('a', 'acc-1'), product('b', 'acc-1'), product('c', 'acc-1'), product('d', 'acc-1', { externalProductRef: undefined }), product('e', 'acc-1', { status: 'archived' }), product('x', 'acc-off')],
  );
  const service = new ProductPolishService(store, mtop, { intervalMs: 60_000, perItemDelayMs: [0, 0], now: () => clock, sleep: async () => undefined, logger: quiet });

  const first = await service.polishAll();
  assert.equal(first.accounts, 1, 'only opted-in, healthy accounts are polished');
  assert.equal(first.polished, 1);
  assert.equal(first.alreadyPolished, 1);
  assert.equal(first.failed, 1);
  assert.deepEqual(calls.map((call) => call.data.itemId), ['item-a', 'item-b', 'item-c']);
  assert.ok(calls.every((call) => call.api === POLISH_API && call.version === POLISH_API_VERSION && call.accountId === 'acc-1'));

  // Within the interval, the success and the "already polished" item are skipped; the rejected one is retried.
  const second = await service.polishAccount('admin', 'acc-1');
  assert.equal(second.skipped, 2);
  assert.deepEqual(calls.slice(3).map((call) => call.data.itemId), ['item-c']);

  clock += 61_000;
  const third = await service.polishAccount('admin', 'acc-1');
  assert.equal(third.skipped, 0);
  assert.equal(calls.length, 7);

  // force ignores the interval entirely
  await service.polishAccount('admin', 'acc-1', { force: true });
  assert.equal(calls.length, 10);
});

test('an invalid credential stops the account loop and the cap limits one run', async () => {
  let calls = 0;
  const invalidMtop = { call: async () => { calls += 1; return { success: false, accountInvalid: true, errorCode: 'ACCOUNT_VALIDATION_REQUIRED', message: 'FAIL_SYS_USER_VALIDATE', cookieHeader: '' }; } };
  const store = fakeStore([account('acc-1')], [product('a', 'acc-1'), product('b', 'acc-1'), product('c', 'acc-1')]);
  const stopped = await new ProductPolishService(store, invalidMtop, { perItemDelayMs: [0, 0], sleep: async () => undefined, logger: quiet }).polishAccount('admin', 'acc-1');
  assert.equal(calls, 1);
  assert.equal(stopped.stoppedReason, 'ACCOUNT_VALIDATION_REQUIRED');
  assert.equal(stopped.failed, 1);

  calls = 0;
  const okMtop = { call: async () => { calls += 1; return { success: true, accountInvalid: false, message: 'SUCCESS::调用成功', cookieHeader: '' }; } };
  const capped = await new ProductPolishService(store, okMtop, { maxItemsPerRun: 2, perItemDelayMs: [0, 0], sleep: async () => undefined, logger: quiet }).polishAccount('admin', 'acc-1');
  assert.equal(calls, 2);
  assert.equal(capped.polished, 2);
  assert.equal(capped.skipped, 1);
});

test('already-polished detection and worker polling', async () => {
  assert.equal(isAlreadyPolishedMessage('FAIL_BIZ_今日已擦亮'), true);
  assert.equal(isAlreadyPolishedMessage('该商品今日已经擦亮过了'), true);
  assert.equal(isAlreadyPolishedMessage('擦亮次数已用完'), true);
  assert.equal(isAlreadyPolishedMessage('FAIL_BIZ_商品不存在'), false);
  let runs = 0;
  const service = { polishAll: async () => { runs += 1; return { accounts: 0, polished: 0, alreadyPolished: 0, failed: 0, results: [] }; } } as unknown as ProductPolishService;
  const worker = new ProductPolishWorker(service, { pollMs: 60_000 });
  await worker.pollOnce();
  await worker.pollOnce();
  assert.equal(runs, 2);
  await worker.stop();
});
