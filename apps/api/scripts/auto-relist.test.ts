import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AutoRelistService, readAutoRelistSettings } from '../src/auto-relist.js';
import type { ProductPublishInput } from '../src/product-publish.js';

async function boot(label: string) {
  const runtime = createApp(loadConfig({
    HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '', REDIS_URL: '', ALLOW_IN_MEMORY: 'true', COOKIE_SECURE: 'false', XIANYU_QR_MODE: 'stub', AGENT_RUNTIME: 'in-process',
    API_KEY: 'test-key', AUTO_REPLY_MODEL_ENABLED: 'false', AUTO_REPLY_SEND_MODE: 'simulate',
  }));
  await runtime.listen();
  const boot = await runtime.auth.bootstrap({ email: `${label}@example.com`, password: 'password-123', displayName: label });
  const account = await runtime.store.createAccount({ adminId: boot.admin.id, platform: 'xianyu', sellerRef: `${label}-seller` });
  return { runtime, adminId: boot.admin.id, account };
}

const png = Buffer.from('89504e470d0a1a0a', 'hex');
const quiet = { info() {}, warn() {} };
const fakeDownload = async () => ({ body: png, contentType: 'image/png' });

function fakePublisher(runtime: Awaited<ReturnType<typeof boot>>['runtime'], calls: ProductPublishInput[]) {
  let counter = 0;
  return {
    async publish(input: ProductPublishInput) {
      calls.push(input);
      counter += 1;
      const itemId = `new-item-${counter}`;
      const product = await runtime.products.create({ adminId: input.adminId, accountId: input.accountId, externalProductRef: itemId, title: input.title, description: input.description, categoryCode: input.categoryCode, priceMinor: input.priceMinor, status: 'published', attributesJson: { publish: { imageUrls: ['https://cdn.example/new.png'], postageMode: input.postageMode } }, requestId: input.requestId, traceId: input.traceId });
      return { product, itemId, itemUrl: `https://www.goofish.com/item?id=${itemId}`, category: { catId: 'c', catName: 'c', channelCatId: 'c' }, postageMode: input.postageMode, imageUrls: ['https://cdn.example/new.png'], replay: { source: 'test', steps: [] } } as never;
    },
  };
}

test('auto relist settings default to disabled with a 60s delay and survive junk', () => {
  assert.deepEqual(readAutoRelistSettings({ attributes: {} }), { enabled: false, delaySeconds: 60 });
  assert.deepEqual(readAutoRelistSettings({ attributes: { autoRelist: { enabled: true, delaySeconds: '15' } } }), { enabled: true, delaySeconds: 15 });
  assert.deepEqual(readAutoRelistSettings({ attributes: { autoRelist: { enabled: 'yes', delaySeconds: -5 } } }), { enabled: false, delaySeconds: 0 });
});

test('an order on an enabled product queues one relist job; the worker republishes, copies automation and retires the old link', async () => {
  const { runtime, adminId, account } = await boot('relist-order');
  try {
    // The store claims by wall-clock time, so anchor the service clock two minutes in the past: a 30s delay is already due.
    const base = Date.now() - 120_000;
    const calls: ProductPublishInput[] = [];
    const service = new AutoRelistService(runtime.store, fakePublisher(runtime, calls), runtime.productAutomation, undefined, async () => 'audit', { logger: quiet, downloadImage: fakeDownload, now: () => base });
    const product = await runtime.products.create({ adminId, accountId: account.id, externalProductRef: 'item-old', title: '游戏点券 100', description: '拍下自动发货', priceMinor: 990, status: 'published', defaultReplyTemplate: '在的', knowledgeBase: '点券说明', attributesJson: { publish: { imageUrls: ['https://cdn.example/a.png', 'https://cdn.example/b.png'], postageMode: 'free' } }, requestId: 'r', traceId: 't' });
    const automationBefore = await runtime.productAutomation.get(adminId, product.id);
    const config = { ...automationBefore.config, paidAutoDelivery: { ...automationBefore.config.paidAutoDelivery, enabled: false, couponBatchIds: [], autoConfirm: true } };
    await runtime.productAutomation.update({ adminId, productId: product.id, expectedConfigVersion: automationBefore.configVersion, config, requestId: 'r', traceId: 't' });

    assert.equal(await service.scheduleForOrder({ adminId, accountId: account.id, productId: product.id, orderNo: 'ORDER-1' }), undefined, 'disabled products never queue');
    const toggled = await service.setAutoRelist({ adminId, accountId: account.id, productIds: [product.id], enabled: true, delaySeconds: 30, requestId: 'r', traceId: 't' });
    assert.deepEqual(readAutoRelistSettings(toggled.products[0]!), { enabled: true, delaySeconds: 30 });

    const job = await service.scheduleForOrder({ adminId, accountId: account.id, productId: product.id, orderNo: 'ORDER-1' });
    assert.ok(job);
    assert.equal(job.dueAt, new Date(base + 30_000).toISOString(), 'delay is applied');
    const duplicate = await service.scheduleForOrder({ adminId, accountId: account.id, productId: product.id, orderNo: 'ORDER-1' });
    assert.equal(duplicate?.id, job.id, 'same order never queues twice');

    const summary = await service.processDue('worker-1', 5);
    assert.deepEqual(summary, { claimed: 1, succeeded: 1, failed: 0, retried: 0, skipped: 0 });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.title, '游戏点券 100');
    assert.equal(calls[0]?.priceMinor, 990);
    assert.equal(calls[0]?.images.length, 2, 'both images are re-uploaded');
    const jobs = await service.listJobs(adminId, { accountId: account.id });
    assert.equal(jobs[0]?.status, 'succeeded');
    assert.equal(jobs[0]?.newExternalProductRef, 'new-item-1');
    const next = await runtime.store.getProduct(adminId, jobs[0]!.newProductId!);
    assert.ok(next);
    assert.equal(next.defaultReplyTemplate, '在的');
    assert.equal(next.knowledgeBase, '点券说明');
    assert.deepEqual(readAutoRelistSettings(next), { enabled: true, delaySeconds: 30 }, 'the chain continues on the new link');
    assert.equal((next.attributes.relist as { fromProductId?: string }).fromProductId, product.id);
    const copied = await runtime.productAutomation.get(adminId, next.id);
    assert.equal(copied.config.paidAutoDelivery.autoConfirm, true, 'automation rules are copied');
    const old = await runtime.store.getProduct(adminId, product.id);
    assert.equal(readAutoRelistSettings(old!).enabled, false, 'old link stops relisting');
    assert.equal((old!.attributes.relist as { state?: string; newProductId?: string }).newProductId, next.id);

    assert.equal(await service.scheduleForOrder({ adminId, accountId: account.id, productId: product.id, orderNo: 'ORDER-2' }), undefined, 'old link is retired');
    const [history] = await service.listJobs(adminId, { productId: next.id });
    assert.equal(history?.id, job.id, 'history is visible from the new link too');
  } finally {
    await runtime.close();
  }
});

test('manual relist retries transient failures with backoff and gives up on permanent ones', async () => {
  const { runtime, adminId, account } = await boot('relist-retry');
  try {
    const base = Date.now() - 120_000;
    const product = await runtime.products.create({ adminId, accountId: account.id, externalProductRef: 'item-x', title: '账号', description: '描述', priceMinor: 100, status: 'published', attributesJson: { publish: { imageUrls: ['https://cdn.example/a.png'] } }, requestId: 'r', traceId: 't' });
    let attempts = 0;
    const flaky = { async publish() { attempts += 1; throw new Error('XIANYU_BUSY'); } };
    const service = new AutoRelistService(runtime.store, flaky as never, runtime.productAutomation, undefined, async () => 'audit', { logger: quiet, downloadImage: fakeDownload, now: () => base, retryBackoffMs: [1_000, 2_000] });
    const { jobs } = await service.relistNow({ adminId, accountId: account.id, productIds: [product.id], requestId: 'r', traceId: 't' });
    assert.equal(jobs.length, 1);
    assert.deepEqual(await service.processDue('w', 5), { claimed: 1, succeeded: 0, failed: 0, retried: 1, skipped: 0 });
    let [job] = await service.listJobs(adminId, { productId: product.id });
    assert.equal(job?.status, 'pending');
    assert.equal(job?.dueAt, new Date(base + 1_000).toISOString(), 'first retry uses the first backoff step');
    assert.equal(job?.lastError, 'XIANYU_BUSY');
    assert.deepEqual(await service.processDue('w', 5), { claimed: 1, succeeded: 0, failed: 0, retried: 1, skipped: 0 });
    [job] = await service.listJobs(adminId, { productId: product.id });
    assert.equal(job?.dueAt, new Date(base + 2_000).toISOString(), 'second retry uses the second backoff step');
    assert.deepEqual(await service.processDue('w', 5), { claimed: 1, succeeded: 0, failed: 1, retried: 0, skipped: 0 }, 'third attempt is the last');
    [job] = await service.listJobs(adminId, { productId: product.id });
    assert.equal(job?.status, 'failed');
    assert.equal(attempts, 3);
    assert.deepEqual(await service.processDue('w', 5), { claimed: 0, succeeded: 0, failed: 0, retried: 0, skipped: 0 }, 'failed jobs are not picked up again');

    const noPrice = await runtime.products.create({ adminId, accountId: account.id, externalProductRef: 'item-y', title: '没价格', description: '描述', status: 'published', attributesJson: { publish: { imageUrls: ['https://cdn.example/a.png'] } }, requestId: 'r', traceId: 't' });
    await service.relistNow({ adminId, accountId: account.id, productIds: [noPrice.id], requestId: 'r', traceId: 't' });
    assert.deepEqual(await service.processDue('w', 5), { claimed: 1, succeeded: 0, failed: 1, retried: 0, skipped: 0 }, 'validation problems fail immediately');
    const [bad] = await service.listJobs(adminId, { productId: noPrice.id });
    assert.match(bad?.lastError ?? '', /没有价格/);
    await assert.rejects(service.relistNow({ adminId, accountId: account.id, productIds: [], requestId: 'r', traceId: 't' }), /至少选择一个商品/);
  } finally {
    await runtime.close();
  }
});
