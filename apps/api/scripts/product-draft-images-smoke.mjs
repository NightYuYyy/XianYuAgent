import assert from 'node:assert/strict';
import { createApp } from '../dist/app.js';

const port = 18680 + (process.pid % 300);
const runtime = createApp({ host: '127.0.0.1', port, cookieSecure: false, allowInMemory: true, sessionIdleMs: 1_800_000, sessionAbsoluteMs: 28_800_000, xianyuQrMode: 'stub' });
await runtime.listen();
const base = `http://127.0.0.1:${port}`;
const cookiesFrom = (response) => (response.headers.getSetCookie?.() ?? []).map((value) => value.split(';', 1)[0]).join('; ');

try {
  const bootstrap = await fetch(`${base}/api/v1/auth/bootstrap`, { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'draft-bootstrap' }, body: JSON.stringify({ email: 'draft@example.com', password: 'password-123456', displayName: 'Draft' }) });
  const bootstrapBody = await bootstrap.json();
  assert.equal(bootstrap.status, 200, JSON.stringify(bootstrapBody));
  const cookie = cookiesFrom(bootstrap);
  const csrf = decodeURIComponent(cookie.match(/csrf_token=([^;]+)/)?.[1] ?? '');
  const adminId = bootstrapBody.data.profile.id;
  const account = await runtime.store.createAccount({ adminId, platform: 'xianyu', sellerRef: 'seller-draft' });
  const draft = await runtime.store.createProduct({ adminId, accountId: account.id, title: '草稿', description: 'd', attributes: { publish: { postageMode: 'none' } }, priceMinor: 1500, status: 'draft' });
  const published = await runtime.store.createProduct({ adminId, accountId: account.id, externalProductRef: 'ITEM-9', title: '已发布', priceMinor: 100, status: 'published' });
  const auth = { cookie, 'x-csrf-token': csrf };

  const form = new FormData();
  form.append('images', new Blob([Buffer.from('png-bytes-1')], { type: 'image/png' }), 'one.png');
  form.append('images', new Blob([Buffer.from('jpg-bytes-2')], { type: 'image/jpeg' }), 'two.jpg');
  const save = await fetch(`${base}/api/v1/products/${draft.id}/draft-images`, { method: 'POST', headers: { ...auth, 'Idempotency-Key': 'draft-images-1' }, body: form });
  const saveBody = await save.json();
  assert.equal(save.status, 200, JSON.stringify(saveBody));
  assert.deepEqual(saveBody.data.images.map((image) => image.name), ['one.png', 'two.jpg']);
  assert.equal(saveBody.data.product.attributesJson.publish.postageMode, 'none', 'existing publish meta is kept');
  assert.equal(saveBody.data.product.attributesJson.publish.draftImages.length, 2);

  const first = await fetch(`${base}/api/v1/products/${draft.id}/draft-images/1`, { headers: auth });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'image/jpeg');
  assert.equal(Buffer.from(await first.arrayBuffer()).toString(), 'jpg-bytes-2');
  const missing = await fetch(`${base}/api/v1/products/${draft.id}/draft-images/5`, { headers: auth });
  assert.equal(missing.status, 404);

  const nonDraftForm = new FormData();
  nonDraftForm.append('images', new Blob([Buffer.from('x')], { type: 'image/png' }), 'x.png');
  const rejected = await fetch(`${base}/api/v1/products/${published.id}/draft-images`, { method: 'POST', headers: { ...auth, 'Idempotency-Key': 'draft-images-2' }, body: nonDraftForm });
  assert.equal(rejected.status, 409);

  const anonymous = await fetch(`${base}/api/v1/products/${draft.id}/draft-images/0`);
  assert.equal(anonymous.status, 401);
  console.log('product draft images smoke passed');
} finally {
  await runtime.close?.();
  process.exit(0);
}
