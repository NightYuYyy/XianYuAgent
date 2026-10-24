import assert from 'node:assert/strict';
import { XianyuMtopClient } from '../dist/xianyu-mtop.js';

const originalFetch = globalThis.fetch;
let captured;
let savedCookie;
let savedMetadata;
let responseMode = 'success';
const rotateCalls = [];
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const body = new URLSearchParams(String(init.body ?? ''));
  captured = { url, headers: init.headers, payload: JSON.parse(body.get('data')) };
  if (responseMode === 'tokenEmpty') return new Response(JSON.stringify({ ret: ['FAIL_SYS_TOKEN_EMPTY::令牌为空'] }), { status: 200, headers: { 'content-type': 'application/json' } });
  if (responseMode === 'rotate') {
    rotateCalls.push(captured.url.searchParams.get('sign'));
    const cookieSent = String(init.headers?.cookie ?? '');
    if (cookieSent.includes('_m_h5_tk=stale')) return new Response(JSON.stringify({ ret: ['FAIL_SYS_TOKEN_EXOIRED::令牌过期'] }), { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': '_m_h5_tk=; Domain=.goofish.com; Path=/; Max-Age=0' } });
    if (!cookieSent.includes('_m_h5_tk=')) return new Response(JSON.stringify({ ret: ['FAIL_SYS_TOKEN_EMPTY::令牌为空'] }), { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': '_m_h5_tk=fresh_123; Domain=.goofish.com; Path=/' } });
  }
  if (responseMode === 'permission') return new Response(JSON.stringify({ ret: ['PERMISSION_EXCEPTION::无权限访问'], data: { errCode: 'PERMISSION_EXCEPTION', errMsg: '无权限访问' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify({
    ret: ['SUCCESS::调用成功'],
    data: { module: { nextPage: 'false', totalCount: '1', items: [{
      commonData: { orderId: 'REQ-1', itemId: 'ITEM-1', orderStatus: '待发货', inRefund: 'false' },
      buyerInfoVO: { buyerId: 'BUYER-1', name: '请求校验买家' },
      priceVO: { totalPrice: '12.34', buyNum: '1' },
      rightVO: { btnList: [] },
    }] } },
  }), { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'rotated=1; Domain=.goofish.com; Path=/; Secure' } });
};

try {
  const client = new XianyuMtopClient({
    loadCredential: async () => ({
      cookieHeader: 'unb=seller-1; _m_h5_tk=token_1',
      metadata: {
        cookies_refresh_snapshot: JSON.stringify([
          { name: '_m_h5_tk', value: 'token_1_suffix', domain: '.goofish.com', path: '/', secure: true },
          { name: 'unb', value: 'seller-1', domain: '.goofish.com', path: '/', secure: true },
          { name: 'seller_only', value: '1', domain: 'seller.goofish.com', path: '/', secure: true },
          { name: 'http_only', value: '1', domain: '.goofish.com', path: '/', secure: true, httpOnly: true },
        ]),
      },
    }),
    saveCookie: async (_adminId, _accountId, cookieHeader, metadata) => { savedCookie = cookieHeader; savedMetadata = metadata; },
  });
  await client.fetchSoldOrders('admin-1', 'account-1');
  assert.deepEqual(captured.payload, {
    pageNumber: 1,
    rowsPerPage: 30,
    orderIds: '',
    queryCode: 'ALL',
    orderSearchParam: '{}',
  });
  assert.equal(captured.headers.referer, 'https://seller.goofish.com/?site=COMMONPRO#/seller-trade/order-manage');
  assert.equal(captured.headers.idle_site_biz_code, undefined);
  const result = await client.fetchOrdersAll('admin-1', 'account-1', 30, 2);
  assert.equal(result.items.length, 1);
  assert.deepEqual(captured.payload, {
    pageNumber: 1,
    rowsPerPage: 30,
    orderIds: '',
    queryCode: 'ALL',
    orderSearchParam: '{}',
  });
  assert.equal(captured.url.searchParams.get('type'), 'json');
  assert.equal(captured.url.searchParams.get('valueType'), 'string');
  assert.equal(captured.url.searchParams.get('spm_cnt'), 'a21107h.42831410.0.0');
  assert.equal(captured.headers.origin, 'https://seller.goofish.com');
  assert.equal(captured.headers.referer, 'https://seller.goofish.com/?site=COMMONPRO#/seller-trade/order-manage');
  assert.equal(captured.headers.idle_site_biz_code, undefined);
  assert.match(captured.headers.cookie, /_m_h5_tk=token_1_suffix/);
  assert.match(captured.headers.cookie, /unb=seller-1/);
  assert.doesNotMatch(captured.headers.cookie, /seller_only=1/);
  assert.match(savedCookie, /_m_h5_tk=token_1_suffix/);
  assert.match(savedCookie, /rotated=1/);
  assert.match(savedMetadata.cookies_refresh_snapshot, /rotated/);
  responseMode = 'success';
  await client.fetchOrdersAll('admin-1', 'account-1', undefined, 1);
  assert.equal(captured.payload.rowsPerPage, 30);
  responseMode = 'permission';
  const denied = await client.fetchOrdersAll('admin-1', 'account-1', 30, 1);
  assert.equal(denied.items.length, 0);
  assert.equal(denied.pages[0].errorCode, 'MTOP_PERMISSION_DENIED');
  const emptySnapshotClient = new XianyuMtopClient({
    loadCredential: async () => ({ cookieHeader: 'unb=legacy', metadata: { cookies_refresh_snapshot: '[]' } }),
    saveCookie: async () => {},
  });
  responseMode = 'tokenEmpty';
  const emptySnapshot = await emptySnapshotClient.fetchOrdersAll('admin-1', 'account-1', 30, 1);
  assert.equal(emptySnapshot.pages[0].errorCode, 'MTOP_TOKEN_MISSING');

  // Regression: MTOP deletes the stale _m_h5_tk, then issues a fresh one on the
  // empty-token request. That must not be treated as a lost login.
  responseMode = 'rotate';
  let rotatedCookie = '';
  const rotateClient = new XianyuMtopClient({
    loadCredential: async () => ({ cookieHeader: 'unb=seller-1; cookie2=abc; _m_h5_tk=stale_1' }),
    saveCookie: async (_adminId, _accountId, cookieHeader) => { rotatedCookie = cookieHeader; },
  });
  const rotated = await rotateClient.fetchOrdersAll('admin-1', 'account-1', 30, 1);
  assert.equal(rotated.pages[0].errorCode, undefined, JSON.stringify(rotated.pages[0]));
  assert.equal(rotateCalls.length, 3);
  assert.match(rotatedCookie, /_m_h5_tk=fresh_123/);
  assert.doesNotMatch(rotatedCookie, /_m_h5_tk=(;|$)/);
  assert.match(rotatedCookie, /cookie2=abc/);
  console.log('xianyu order request smoke passed');
} finally {
  globalThis.fetch = originalFetch;
}
