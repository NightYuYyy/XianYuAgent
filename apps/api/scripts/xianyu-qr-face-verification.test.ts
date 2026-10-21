import assert from 'node:assert/strict';
import test from 'node:test';
import { XianyuQrLoginAdapter } from '../src/xianyu-qr-login.js';

/**
 * Replays the Havana identity-verification chain the way Xianyu serves it:
 * query.do CONFIRMED + iframeRedirect -> mini_login_check.htm -> (302) normal_validate.htm
 * -> verify_modes.htm -> (302) identity_verify.htm (face QR) -> photoVerify/check.do
 * polls -> ivCheckLogin.htm issues unb -> /im completes the login.
 */
test('QR login replays the face-verification pages over HTTP, surfaces the face QR and finishes login after the phone succeeds', async () => {
  const originalFetch = globalThis.fetch;
  const statuses: Array<{ status: string; errorCode?: string; faceQr: boolean; autoLaunch?: boolean }> = [];
  const hits: string[] = [];
  let checks = 0;
  let browserCalls = 0;
  let successCount = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    hits.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname.endsWith('/mtop.gaia.nodejs.gaia.idle.data.gw.v2.index.get/1.0/')) {
      return new Response('', { status: 200, headers: { 'set-cookie': '_m_h5_tk=qr-token_suffix; Domain=.goofish.com; Path=/; Secure' } });
    }
    if (url.pathname.endsWith('/mini_login.htm')) {
      return new Response('<script>window.viewData = {"loginFormData":{"lg_token":"login-token"}};</script>', { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (url.pathname.endsWith('/newlogin/qrcode/generate.do')) {
      return new Response(JSON.stringify({ content: { success: true, data: { codeContent: 'qr-face', t: '1', ck: 'ck-face' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname.endsWith('/newlogin/qrcode/query.do')) {
      return new Response(JSON.stringify({ content: { data: { qrCodeStatus: 'CONFIRMED', iframeRedirect: true, iframeRedirectUrl: 'https://passport.goofish.com/iv/remote/pc/mini_login_check.htm?havana_iv_token=CN-SPLIT-redacted' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/iv/remote/pc/mini_login_check.htm') {
      return new Response(null, { status: 302, headers: { location: '/iv/mini/normal_validate.htm?htoken=HTOKEN123' } });
    }
    if (url.pathname === '/iv/mini/normal_validate.htm') {
      return new Response('<html><script>var htoken="HTOKEN123"; window.location.href = "https://passport.goofish.com/iv/mini/verify_modes.htm?htoken=HTOKEN123&_umidfg=" + window._iv_umidfg;</script></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (url.pathname === '/iv/mini/verify_modes.htm') {
      assert.equal(url.searchParams.get('_umidfg'), '1', 'the runtime-appended umid flag is reproduced');
      return new Response(null, { status: 302, headers: { location: '/iv/mini/identity_verify.htm?htoken=HTOKEN123' } });
    }
    if (url.pathname === '/iv/mini/identity_verify.htm') {
      return new Response('<html><script>new Qrcode({ text: "https://passport.goofish.com/iv/face?token=FACE-TOKEN", width: 200 });</script></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (url.pathname === '/iv/photoVerify/check.do') {
      assert.equal(url.searchParams.get('htoken'), 'HTOKEN123');
      checks += 1;
      const body = checks < 2 ? { content: { code: 0 } } : { content: { code: 3, url: '/iv/remote/pc/ivCheckLogin.htm?htoken=HTOKEN123' } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/iv/remote/pc/ivCheckLogin.htm') {
      return new Response('ok', { status: 200, headers: { 'set-cookie': 'unb=face-user; Domain=.goofish.com; Path=/; Secure' } });
    }
    if (url.hostname === 'www.goofish.com' && url.pathname === '/im') {
      return new Response('<html>im</html>', { status: 200 });
    }
    throw new Error(`unexpected request: ${url.href}`);
  };

  const verificationBrowser = { enabled: false, waitForCompletion: async () => { browserCalls += 1; throw new Error('BROWSER_SHOULD_NOT_RUN'); } };
  try {
    const adapter = new XianyuQrLoginAdapter({
      pollIntervalMs: 5,
      maxWaitMs: 5_000,
      verificationBrowser: verificationBrowser as never,
      allowManualVerificationFallback: false,
      onStatus: async (status) => { statuses.push({ status: status.status, errorCode: status.errorCode, faceQr: Boolean(status.faceQrImageDataUrl), autoLaunch: status.verificationAutoLaunch }); },
      onSuccess: async ({ unb }) => { if (unb === 'face-user') successCount += 1; },
    });
    await adapter.create({ sessionId: 'face-session', adminId: 'admin-1' });
    for (let attempt = 0; attempt < 200 && successCount === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(successCount, 1, 'login completes after the phone-side face check succeeds');
    assert.equal(browserCalls, 0, 'the HTTP replay makes the server-side browser unnecessary');
    assert.equal(adapter.get('face-session')?.status, 'succeeded');
    assert.ok(statuses.some((entry) => entry.status === 'verification_required' && entry.faceQr && entry.errorCode === 'FACE_VERIFICATION_REQUIRED' && entry.autoLaunch === true), 'the face QR is published while waiting and keeps the client polling even without a server-side browser');
    assert.equal(statuses.at(-1)?.status, 'succeeded');
    assert.equal(statuses.at(-1)?.faceQr, false, 'the face QR is cleared once the login finished');
    assert.ok(checks >= 2, 'check.do is polled until it reports success');
    assert.ok(hits.includes('GET /iv/remote/pc/ivCheckLogin.htm'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('QR login falls back to the server-side browser when the identity pages are not recognised', async () => {
  const originalFetch = globalThis.fetch;
  let browserCalls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/mtop.gaia.nodejs.gaia.idle.data.gw.v2.index.get/1.0/')) return new Response('', { status: 200, headers: { 'set-cookie': '_m_h5_tk=qr-token_suffix; Domain=.goofish.com; Path=/; Secure' } });
    if (url.pathname.endsWith('/mini_login.htm')) return new Response('<script>window.viewData = {"loginFormData":{"lg_token":"login-token"}};</script>', { status: 200 });
    if (url.pathname.endsWith('/newlogin/qrcode/generate.do')) return new Response(JSON.stringify({ content: { success: true, data: { codeContent: 'qr', t: '1', ck: 'ck' } } }), { status: 200 });
    if (url.pathname.endsWith('/newlogin/qrcode/query.do')) return new Response(JSON.stringify({ content: { data: { qrCodeStatus: 'CONFIRMED', iframeRedirect: true, iframeRedirectUrl: 'https://passport.goofish.com/iv/remote/pc/mini_login_check.htm?havana_iv_token=x' } } }), { status: 200 });
    if (url.pathname === '/iv/remote/pc/mini_login_check.htm') return new Response('<html>something new</html>', { status: 200 });
    if (url.hostname === 'www.goofish.com' && url.pathname === '/im') return new Response('im', { status: 200, headers: { 'set-cookie': 'unb=browser-user; Domain=.goofish.com; Path=/; Secure' } });
    throw new Error(`unexpected request: ${url.href}`);
  };
  const verificationBrowser = { enabled: true, waitForCompletion: async () => { browserCalls += 1; return { finalUrl: 'https://www.goofish.com/im', cookieSnapshot: [{ name: 'unb', value: 'browser-user', domain: '.goofish.com', path: '/' }] }; } };
  try {
    let successCount = 0;
    const adapter = new XianyuQrLoginAdapter({ pollIntervalMs: 5, maxWaitMs: 2_000, verificationBrowser: verificationBrowser as never, allowManualVerificationFallback: false, onSuccess: async () => { successCount += 1; } });
    await adapter.create({ sessionId: 'fallback-session', adminId: 'admin-1' });
    for (let attempt = 0; attempt < 100 && successCount === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(browserCalls, 1);
    assert.equal(successCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
