import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPatchrightVerificationBrowserFactory, isStaleChromiumSingleton } from '../src/patchright-verification-browser.js';
import { isVerificationPageComplete, resolveDefaultVerificationUserDataDir, resolveVerificationCookieUrl, shouldHideVerificationWindow, shouldUseHeadlessVerificationBrowser, XianyuVerificationBrowser } from '../src/xianyu-verification-browser.js';
import { loadConfig } from '../src/config.js';

test('verification completion requires a fresh x5sec cookie after leaving punish', () => {
  assert.equal(isVerificationPageComplete('https://www.goofish.com/punish?x=1', []), false);
  assert.equal(isVerificationPageComplete('https://www.goofish.com/punish?x=1', [{ name: 'x5sec', value: 'redacted', domain: '.goofish.com', path: '/' }]), false);
  assert.equal(isVerificationPageComplete('https://www.goofish.com/im', [{ name: 'x5sec', value: 'fresh', domain: '.goofish.com', path: '/' }]), true);
  assert.equal(isVerificationPageComplete('https://www.goofish.com/im', [{ name: 'x5sec', value: 'same', domain: '.goofish.com', path: '/' }], [{ name: 'x5sec', value: 'same', domain: '.goofish.com', path: '/' }]), false);
  assert.equal(isVerificationPageComplete('https://www.goofish.com/im', []), false);
  assert.equal(isVerificationPageComplete('https://example.com/im', []), false);
});

test('verification browser configuration is explicit and disabled by default', () => {
  const config = loadConfig({ ALLOW_IN_MEMORY: 'true', XIANYU_QR_MODE: 'stub' });
  assert.equal(config.xianyuVerificationBrowserMode, 'disabled');
  assert.equal(config.xianyuVerificationBrowserHeadless, false);
  assert.equal(loadConfig({ ALLOW_IN_MEMORY: 'true', XIANYU_VERIFICATION_BROWSER_MODE: 'launch', XIANYU_VERIFICATION_BROWSER_HEADLESS: 'true' }).xianyuVerificationBrowserMode, 'launch');
  assert.equal(loadConfig({ ALLOW_IN_MEMORY: 'true', XIANYU_VERIFICATION_BROWSER_MODE: 'connect' }).xianyuVerificationBrowserMode, 'disabled');
});

test('implicit verification profiles stay outside the workspace', () => {
  assert.equal(resolveDefaultVerificationUserDataDir(), join(tmpdir(), 'xianyu-agent', 'browser_data', 'xianyu-verification'));
  assert.notEqual(resolveDefaultVerificationUserDataDir(), join(process.cwd(), 'browser_data', 'xianyu-verification'));
});

test('automatic verification honors explicit headless configuration and avoids a visible blank window', () => {
  const previous = process.env.XIANYU_VERIFICATION_AUTO_HEADLESS;
  delete process.env.XIANYU_VERIFICATION_AUTO_HEADLESS;
  try {
    assert.equal(shouldUseHeadlessVerificationBrowser('auto', true), true);
    assert.equal(shouldUseHeadlessVerificationBrowser('auto', false), false);
    assert.equal(shouldUseHeadlessVerificationBrowser('disabled', true), true);
    assert.equal(shouldHideVerificationWindow('auto', false), true);
    assert.equal(shouldHideVerificationWindow('auto', false, true), false);
    assert.equal(shouldHideVerificationWindow('auto', true), false);
    assert.equal(shouldHideVerificationWindow('disabled', false), false);
    assert.equal(resolveVerificationCookieUrl('https://punish.goofish.com/verify?token=redacted#challenge'), 'https://punish.goofish.com/verify');
  } finally {
    if (previous === undefined) delete process.env.XIANYU_VERIFICATION_AUTO_HEADLESS;
    else process.env.XIANYU_VERIFICATION_AUTO_HEADLESS = previous;
  }
});

test('verification browser rejects blank or unrelated targets before opening Chrome', async () => {
  const { XianyuVerificationBrowser } = await import('../src/xianyu-verification-browser.js');
  const browser = new XianyuVerificationBrowser({ mode: 'launch', sliderMode: 'auto' });
  await assert.rejects(
    () => browser.waitForCompletion({ verificationUrl: 'about:blank', maxWaitMs: 500 }),
    (error: unknown) => error instanceof Error && error.message === 'XIANYU_VERIFICATION_URL_INVALID',
  );
  await assert.rejects(
    () => browser.waitForCompletion({ verificationUrl: 'https://example.com/punish', maxWaitMs: 500 }),
    (error: unknown) => error instanceof Error && error.message === 'XIANYU_VERIFICATION_URL_INVALID',
  );
});

test('Patchright persistent Chrome completes only after fresh x5sec and leaving punish', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'xianyu-patchright-verification-test-'));
  const fixture = createServer((request, response) => {
    if (request.url === '/punish') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><div id="challenge">滑动验证</div><script>setTimeout(() => { document.cookie = "x5sec=fresh-fixture; path=/"; location.href = "/im"; }, 50)</script>');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>done</title><p>verified</p>');
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', () => resolve()));
  const address = fixture.address();
  assert.ok(address && typeof address === 'object');
  const verificationUrl = `http://127.0.0.1:${address.port}/punish`;
  try {
    const browser = new XianyuVerificationBrowser({ mode: 'launch', sliderMode: 'disabled', headless: true, userDataDir: profile, maxWaitMs: 8_000, pollIntervalMs: 100 });
    const result = await browser.waitForCompletion({ verificationUrl, profileKey: 'fixture-account' });
    assert.equal(result.finalUrl, `http://127.0.0.1:${address.port}/im`);
    assert.equal(result.cookieSnapshot.find((cookie) => cookie.name === 'x5sec')?.value, 'fresh-fixture');
  } finally {
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
  }
});

test('real Patchright reuses one clean page per profile across sequential verifications', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'xianyu-patchright-verification-repeat-test-'));
  const fixture = createServer((request, response) => {
    if (request.url === '/punish') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><div id="challenge">滑动验证</div><script>setTimeout(() => { document.cookie = "x5sec=fresh-repeat-fixture; path=/"; location.href = "/im"; }, 50)</script>');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>done</title><p>verified</p>');
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', () => resolve()));
  const address = fixture.address();
  assert.ok(address && typeof address === 'object');
  const verificationUrl = `http://127.0.0.1:${address.port}/punish`;
  const baseFactory = createPatchrightVerificationBrowserFactory();
  const launches: Array<{ pagesAtLaunch: number; pagesBeforeClose: number; closeCount: number }> = [];
  const browserFactory = {
    launchPersistentContext: async (options: Parameters<typeof baseFactory.launchPersistentContext>[0]) => {
      const context = await baseFactory.launchPersistentContext(options);
      const snapshot = { pagesAtLaunch: context.pages().length, pagesBeforeClose: -1, closeCount: 0 };
      const close = context.close.bind(context);
      context.close = async () => {
        snapshot.pagesBeforeClose = context.pages().length;
        await close();
        snapshot.closeCount += 1;
      };
      launches.push(snapshot);
      return context;
    },
  };
  try {
    const browser = new XianyuVerificationBrowser({ mode: 'launch', sliderMode: 'disabled', headless: true, userDataDir: profile, maxWaitMs: 8_000, pollIntervalMs: 100, browserFactory });
    const first = await browser.waitForCompletion({ verificationUrl, profileKey: 'repeat-account' });
    await assert.rejects(() => access(join(profile, 'repeat-account', 'SingletonLock')));
    const second = await browser.waitForCompletion({ verificationUrl, profileKey: 'repeat-account' });
    assert.equal(first.cookieSnapshot.find((cookie) => cookie.name === 'x5sec')?.value, 'fresh-repeat-fixture');
    assert.equal(second.cookieSnapshot.find((cookie) => cookie.name === 'x5sec')?.value, 'fresh-repeat-fixture');
    assert.deepEqual(launches.map((entry) => entry.pagesAtLaunch), [1, 1]);
    assert.deepEqual(launches.map((entry) => entry.pagesBeforeClose), [0, 0]);
    assert.deepEqual(launches.map((entry) => entry.closeCount), [1, 1]);
    await assert.rejects(() => access(join(profile, 'repeat-account', 'SingletonLock')));
  } finally {
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
  }
});

test('Chromium SingletonLock ownership compares live process paths safely', async () => {
  assert.equal(await isStaleChromiumSingleton(
    { host: 'test-host', pid: 42 },
    'C:\\Temp\\XianYu\\Profile',
    {
      host: 'test-host',
      isProcessAlive: () => true,
      readProcessCommandLine: async () => 'chrome.exe --user-data-dir="c:/temp/xianyu/profile"',
    },
  ), false);
  assert.equal(await isStaleChromiumSingleton(
    { host: 'test-host', pid: 42 },
    'C:\\Temp\\XianYu\\Profile',
    {
      host: 'test-host',
      isProcessAlive: () => true,
      readProcessCommandLine: async () => 'chrome.exe --user-data-dir="c:/temp/other/profile"',
    },
  ), true);
  assert.equal(await isStaleChromiumSingleton(
    { host: 'test-host', pid: 42 },
    'C:\\Temp\\XianYu\\Profile',
    {
      host: 'test-host',
      isProcessAlive: () => false,
      readProcessCommandLine: async () => '',
    },
  ), true);
});
