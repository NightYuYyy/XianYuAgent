import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  REMOTE_SLIDER_REJECTED,
  REMOTE_SLIDER_UNAUTHORIZED,
  REMOTE_SLIDER_UNAVAILABLE,
  REMOTE_SLIDER_URL_EXPIRED,
  XianyuRemoteSliderSolver,
  remoteSliderCookiesToSnapshot,
} from '../src/xianyu-remote-slider.js';
import { XianyuVerificationBrowser } from '../src/xianyu-verification-browser.js';

const PUNISH_URL = 'https://h5api.m.goofish.com/h5/mtop.taobao.idlemessage.pc.login.token/1.0/_____tmd_____/punish?x5secdata=redacted&x5step=2';
const quietLogger = { info: () => undefined, warn: () => undefined };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('remote slider client speaks the xianyu-auto-reply slider-solve protocol', async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const solver = new XianyuRemoteSliderSolver({
    url: 'http://solver.local/api/v1/captcha/slider-solve',
    secret: 'shared-secret',
    browserTimeoutSeconds: 45,
    logger: quietLogger,
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return jsonResponse({ success: true, data: { cookies: { x5sec: 'fresh-x5sec', x5secdata: 'challenge' } } });
    },
  });
  assert.equal(solver.enabled, true);
  const result = await solver.solve({ verificationUrl: PUNISH_URL, accountId: 'acc-1', cookieHeader: 'unb=1; cookie2=abc', deviceId: 'dev-1' });
  assert.deepEqual(result.cookies, { x5sec: 'fresh-x5sec', x5secdata: 'challenge' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, 'http://solver.local/api/v1/captcha/slider-solve');
  assert.deepEqual(requests[0]?.body, {
    secret_key: 'shared-secret',
    account_id: 'acc-1',
    url: PUNISH_URL,
    browser_timeout: 45,
    cookies: 'unb=1; cookie2=abc',
    device_id: 'dev-1',
  });
});

test('remote slider client maps every failure shape to a stable error code', async () => {
  const make = (fetchImpl: typeof fetch) => new XianyuRemoteSliderSolver({ url: 'http://solver.local/solve', secret: 's', logger: quietLogger, fetchImpl });
  await assert.rejects(() => make(async () => { throw new TypeError('fetch failed'); }).solve({ verificationUrl: PUNISH_URL }), (error: unknown) => error instanceof Error && error.message === REMOTE_SLIDER_UNAVAILABLE);
  await assert.rejects(() => make(async () => new Response('bad gateway', { status: 502 })).solve({ verificationUrl: PUNISH_URL }), (error: unknown) => error instanceof Error && error.message === REMOTE_SLIDER_UNAVAILABLE);
  await assert.rejects(() => make(async () => jsonResponse({ success: false, message: '秘钥错误' }, 401)).solve({ verificationUrl: PUNISH_URL }), (error: unknown) => error instanceof Error && error.message === REMOTE_SLIDER_UNAUTHORIZED);
  await assert.rejects(() => make(async () => jsonResponse({ success: false, message: '验证链接已过期', data: { url_expired: true } })).solve({ verificationUrl: PUNISH_URL }), (error: unknown) => error instanceof Error && error.message === REMOTE_SLIDER_URL_EXPIRED);
  await assert.rejects(() => make(async () => jsonResponse({ success: false, message: '滑块验证未通过' })).solve({ verificationUrl: PUNISH_URL }), (error: unknown) => error instanceof Error && error.message === REMOTE_SLIDER_REJECTED);
  // success flag without cookies is not a success
  await assert.rejects(() => make(async () => jsonResponse({ success: true, data: { cookies: {} } })).solve({ verificationUrl: PUNISH_URL }), (error: unknown) => error instanceof Error && error.message === REMOTE_SLIDER_REJECTED);
  assert.equal(new XianyuRemoteSliderSolver({ url: '', secret: 'x', logger: quietLogger }).enabled, false);
});

test('remote cookies are attached to the goofish top site', () => {
  assert.deepEqual(remoteSliderCookiesToSnapshot({ x5sec: 'v1', ' x5secdata ': 'v2' }), [
    { name: 'x5sec', value: 'v1', domain: '.goofish.com', path: '/', secure: true },
    { name: 'x5secdata', value: 'v2', domain: '.goofish.com', path: '/', secure: true },
  ]);
});

test('verification browser delegates slider challenges to the remote solver without launching Chrome', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'xianyu-remote-slider-test-'));
  const browserFactory = { launchPersistentContext: async () => { throw new Error('FACTORY_REACHED'); } };
  const remoteSlider = new XianyuRemoteSliderSolver({
    url: 'http://solver.local/solve',
    secret: 's',
    logger: quietLogger,
    fetchImpl: async () => jsonResponse({ success: true, data: { cookies: { x5sec: 'remote-x5sec', x5secdata: 'stale-challenge' } } }),
  });
  try {
    const browser = new XianyuVerificationBrowser({ mode: 'launch', sliderMode: 'auto', userDataDir: profile, browserFactory, remoteSlider });
    assert.equal(browser.remoteSliderEnabled, true);
    const result = await browser.waitForCompletion({
      verificationUrl: PUNISH_URL,
      profileKey: 'acc-1',
      accountId: 'acc-1',
      initialCookieSnapshot: [
        { name: 'unb', value: '42', domain: '.goofish.com', path: '/' },
        { name: 'x5sec', value: 'old-x5sec', domain: 'h5api.m.goofish.com', path: '/' },
        { name: 'x5secdata', value: 'old-challenge', domain: '.goofish.com', path: '/' },
      ],
    });
    assert.equal(result.finalUrl, PUNISH_URL);
    const byName = Object.fromEntries(result.cookieSnapshot.map((cookie) => [cookie.name, cookie]));
    assert.equal(byName.unb?.value, '42');
    assert.equal(byName.x5sec?.value, 'remote-x5sec');
    assert.equal(byName.x5sec?.domain, '.goofish.com');
    assert.equal(result.cookieSnapshot.filter((cookie) => cookie.name === 'x5sec').length, 1, 'old per-host x5sec is replaced, not duplicated');
    assert.equal(byName.x5secdata, undefined, 'challenge markers are dropped once a fresh x5sec exists');

    // Identity (face) verification never goes to the remote solver.
    await assert.rejects(
      () => browser.waitForCompletion({ verificationUrl: 'https://passport.goofish.com/iv/remote/pc/mini_login_check.htm?havana_iv_token=x', profileKey: 'acc-1' }),
      (error: unknown) => error instanceof Error && error.message === 'FACTORY_REACHED',
    );
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test('remote solver outage falls back to the local browser only when allowed', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'xianyu-remote-slider-fallback-test-'));
  const browserFactory = { launchPersistentContext: async () => { throw new Error('FACTORY_REACHED'); } };
  const unreachable = new XianyuRemoteSliderSolver({ url: 'http://solver.local/solve', secret: 's', logger: quietLogger, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  const rejecting = new XianyuRemoteSliderSolver({ url: 'http://solver.local/solve', secret: 's', logger: quietLogger, fetchImpl: async () => jsonResponse({ success: false, message: 'no' }) });
  try {
    await assert.rejects(
      () => new XianyuVerificationBrowser({ mode: 'launch', userDataDir: profile, browserFactory, remoteSlider: unreachable, remoteSliderFallback: 'local' }).waitForCompletion({ verificationUrl: PUNISH_URL, profileKey: 'a' }),
      (error: unknown) => error instanceof Error && error.message === 'FACTORY_REACHED',
    );
    await assert.rejects(
      () => new XianyuVerificationBrowser({ mode: 'launch', userDataDir: profile, browserFactory, remoteSlider: unreachable, remoteSliderFallback: 'none' }).waitForCompletion({ verificationUrl: PUNISH_URL, profileKey: 'a' }),
      (error: unknown) => error instanceof Error && error.message === REMOTE_SLIDER_UNAVAILABLE,
    );
    // A definite rejection from the remote is final even with local fallback enabled.
    await assert.rejects(
      () => new XianyuVerificationBrowser({ mode: 'launch', userDataDir: profile, browserFactory, remoteSlider: rejecting, remoteSliderFallback: 'local' }).waitForCompletion({ verificationUrl: PUNISH_URL, profileKey: 'a' }),
      (error: unknown) => error instanceof Error && error.message === REMOTE_SLIDER_REJECTED,
    );
    // Remote-only deployments (no local browser) still work for sliders.
    const remoteOnly = new XianyuVerificationBrowser({ mode: 'disabled', browserFactory, remoteSlider: new XianyuRemoteSliderSolver({ url: 'http://solver.local/solve', secret: 's', logger: quietLogger, fetchImpl: async () => jsonResponse({ success: true, data: { cookies: { x5sec: 'ok' } } }) }) });
    assert.equal(remoteOnly.enabled, true);
    assert.equal((await remoteOnly.waitForCompletion({ verificationUrl: PUNISH_URL, profileKey: 'a' })).cookieSnapshot[0]?.value, 'ok');
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
