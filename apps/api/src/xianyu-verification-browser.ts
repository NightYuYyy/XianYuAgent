import { notify } from './notifier.js';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dropStaleCaptchaChallengeCookies, normalizeCookieSnapshot, type XianyuCookieSnapshot } from './xianyu-cookie-jar.js';
import { createPatchrightVerificationBrowserFactory } from './patchright-verification-browser.js';
import { XIANYU_USER_AGENT } from './xianyu-browser-identity.js';
import type { XianyuVerificationBrowserFactory, XianyuVerificationContext, XianyuVerificationCookie, XianyuVerificationPage } from './xianyu-browser-port.js';
import { acquireXianyuVerificationProfileLock } from './xianyu-verification-profile-lock.js';
import { XianyuSliderSolver, type XianyuSliderMode } from './xianyu-slider-solver.js';
import { cookieHeaderFromSnapshot } from './xianyu-cookie-jar.js';
import { isRemoteSliderRetryableError, remoteSliderCookiesToSnapshot, type XianyuRemoteSliderSolver } from './xianyu-remote-slider.js';

export type XianyuVerificationBrowserMode = 'disabled' | 'launch';

/**
 * Xianyu serves two different second-factor pages after a QR scan or an MTOP
 * call is challenged:
 *
 * - `slider`: a Baxia/NC slider on a `punish|captcha|verify|security` URL. The
 *   page is finished when it leaves that URL and a fresh `x5sec` cookie exists.
 * - `identity`: a Havana identity-verification (人脸/短信) page under
 *   `passport.goofish.com/iv/...`. The user completes it on their phone; the
 *   PC page keeps polling and, once the phone succeeds, finishes the login
 *   itself and writes `unb` plus the other session cookies. Nothing can be
 *   automated here, but the page must stay open or the login never completes.
 */
export type XianyuVerificationKind = 'slider' | 'identity';

export interface XianyuVerificationBrowserOptions {
  mode?: XianyuVerificationBrowserMode;
  sliderMode?: XianyuSliderMode;
  sliderMaxRetries?: number;
  headless?: boolean;
  executablePath?: string;
  userDataDir?: string;
  maxWaitMs?: number;
  pollIntervalMs?: number;
  allowManualFallback?: boolean;
  userAgent?: string;
  /** Injectable boundary for unit tests and future browser implementations. */
  browserFactory?: XianyuVerificationBrowserFactory;
  /** External physical-mouse solver tried first for slider challenges. */
  remoteSlider?: XianyuRemoteSliderSolver;
  /** When the remote solver is unreachable: 'local' retries with the browser, 'none' fails. */
  remoteSliderFallback?: 'local' | 'none';
}

export interface XianyuVerificationBrowserResult {
  finalUrl: string;
  cookieSnapshot: XianyuCookieSnapshot;
}

const DEFAULT_MAX_WAIT_MS = 3 * 60_000;
/** Phone-side face/SMS verification needs the user to pick up the phone; 3 minutes is routinely too short. */
const IDENTITY_MAX_WAIT_MS = 10 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

/**
 * A persistent Chrome profile is a singleton resource. Keep this state at
 * module scope so separate service instances in the same API process cannot
 * launch two contexts against one profile and create duplicate tabs.
 */
const activeVerifications = new Map<string, Promise<XianyuVerificationBrowserResult>>();
const profileVerificationTails = new Map<string, Promise<void>>();

/**
 * Keep implicit Chrome profiles outside the repository. Production and
 * container deployments should pass an explicit persistent directory when
 * they need profile reuse; local development must not pollute the workspace.
 */
export function resolveDefaultVerificationUserDataDir(): string {
  return join(tmpdir(), 'xianyu-agent', 'browser_data', 'xianyu-verification');
}

/**
 * Patchright-only verification browser.
 *
 * A persistent system Chrome profile is used per account/session. There is
 * intentionally no CDP fallback: the old CDP path caused blank-window races
 * and made slider input look automated to the platform.
 */
export class XianyuVerificationBrowser {
  private readonly mode: XianyuVerificationBrowserMode;
  private readonly sliderMode: XianyuSliderMode;
  private readonly sliderMaxRetries: number;
  private readonly headless: boolean;
  private readonly executablePath?: string;
  private readonly configuredUserDataDir?: string;
  private readonly maxWaitMs: number;
  private readonly pollIntervalMs: number;
  private readonly allowManualFallback: boolean;
  private readonly userAgent?: string;
  private readonly browserFactory: XianyuVerificationBrowserFactory;
  private readonly remoteSlider?: XianyuRemoteSliderSolver;
  private readonly remoteSliderFallback: 'local' | 'none';

  constructor(options: XianyuVerificationBrowserOptions = {}) {
    this.remoteSlider = options.remoteSlider?.enabled ? options.remoteSlider : undefined;
    this.remoteSliderFallback = options.remoteSliderFallback ?? 'local';
    this.mode = options.mode ?? 'disabled';
    this.sliderMode = options.sliderMode ?? 'disabled';
    this.sliderMaxRetries = Math.max(1, Math.floor(options.sliderMaxRetries ?? 3));
    this.headless = options.headless ?? false;
    this.executablePath = options.executablePath;
    this.configuredUserDataDir = options.userDataDir;
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.allowManualFallback = options.allowManualFallback ?? false;
    this.userAgent = options.userAgent?.trim() || process.env.XIANYU_BROWSER_USER_AGENT?.trim() || XIANYU_USER_AGENT;
    this.browserFactory = options.browserFactory ?? createPatchrightVerificationBrowserFactory();
  }

  get enabled(): boolean { return this.mode !== 'disabled' || this.remoteSlider !== undefined; }

  /** True when slider challenges are delegated to the external physical-mouse solver. */
  get remoteSliderEnabled(): boolean { return this.remoteSlider !== undefined; }

  async waitForCompletion(input: {
    verificationUrl: string;
    profileKey?: string;
    initialCookieSnapshot?: XianyuCookieSnapshot;
    allowManualFallback?: boolean;
    maxWaitMs?: number;
    pollIntervalMs?: number;
    /** Forwarded to the remote solver so the fresh x5sec is bound to the right account. */
    accountId?: string;
    deviceId?: string;
    /** Outbound proxy for the verification browser; undefined = direct. */
    proxyUrl?: string;
  }): Promise<XianyuVerificationBrowserResult> {
    assertVerificationUrl(input.verificationUrl);
    if (this.remoteSlider && classifyVerificationUrl(input.verificationUrl) === 'slider') {
      const remote = await this.solveWithRemoteSlider(input);
      if (remote) return remote;
    }
    if (this.mode === 'disabled') throw new Error('XIANYU_VERIFICATION_BROWSER_DISABLED');
    const profileDir = await this.resolveProfileDir(input.profileKey);
    const profileLockKey = normalizeProfileLockKey(profileDir);
    const verificationKey = `${profileLockKey}\u0000${input.verificationUrl}\u0000${JSON.stringify(input.initialCookieSnapshot ?? [])}`;
    const active = activeVerifications.get(verificationKey);
    if (active) return active;

    const previous = profileVerificationTails.get(profileLockKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    profileVerificationTails.set(profileLockKey, tail);

    const task = (async () => {
      await previous;
      try {
        return await this.runVerification(input, profileDir);
      } finally {
        release();
        if (profileVerificationTails.get(profileLockKey) === tail) profileVerificationTails.delete(profileLockKey);
      }
    })();
    activeVerifications.set(verificationKey, task);
    try {
      return await task;
    } finally {
      if (activeVerifications.get(verificationKey) === task) activeVerifications.delete(verificationKey);
    }
  }

  /**
   * Returns the merged cookie snapshot on success, `undefined` when the remote
   * is unreachable and the local browser should take over, and throws when the
   * remote answered but could not pass the slider.
   */
  private async solveWithRemoteSlider(input: {
    verificationUrl: string;
    profileKey?: string;
    initialCookieSnapshot?: XianyuCookieSnapshot;
    accountId?: string;
    deviceId?: string;
  }): Promise<XianyuVerificationBrowserResult | undefined> {
    if (!this.remoteSlider) return undefined;
    const initialSnapshot = normalizeCookieSnapshot(input.initialCookieSnapshot) ?? [];
    const accountId = input.accountId ?? input.profileKey;
    try {
      const result = await this.remoteSlider.solve({
        verificationUrl: input.verificationUrl,
        accountId,
        cookieHeader: cookieHeaderFromSnapshot(initialSnapshot) || undefined,
        deviceId: input.deviceId,
      });
      const merged = mergeSnapshots(initialSnapshot, remoteSliderCookiesToSnapshot(result.cookies));
      console.info(JSON.stringify({ component: 'xianyu-verification', event: 'remote_slider_completed', accountId, elapsedMs: result.elapsedMs }));
      return { finalUrl: input.verificationUrl, cookieSnapshot: dropStaleCaptchaChallengeCookies(merged) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (isRemoteSliderRetryableError(error) && this.remoteSliderFallback === 'local' && this.mode !== 'disabled') {
        console.warn(JSON.stringify({ component: 'xianyu-verification', event: 'remote_slider_fallback_local', accountId, reason }));
        return undefined;
      }
      console.warn(JSON.stringify({ component: 'xianyu-verification', event: 'remote_slider_failed', accountId, reason }));
      notify({ kind: 'remote_slider_failed', title: '远程过滑块失败', body: `原因：${reason}\n账号可能需要人工验证。`, accountId, dedupeKey: `remote-slider:${accountId ?? 'unknown'}` });
      throw error;
    }
  }

  private async runVerification(input: {
    verificationUrl: string;
    profileKey?: string;
    initialCookieSnapshot?: XianyuCookieSnapshot;
    allowManualFallback?: boolean;
    maxWaitMs?: number;
    pollIntervalMs?: number;
    proxyUrl?: string;
  }, profileDir: string): Promise<XianyuVerificationBrowserResult> {
    const kind = classifyVerificationUrl(input.verificationUrl);
    const defaultMaxWaitMs = kind === 'identity' ? Math.max(this.maxWaitMs, IDENTITY_MAX_WAIT_MS) : this.maxWaitMs;
    const maxWaitMs = Math.max(250, Math.floor(input.maxWaitMs ?? defaultMaxWaitMs));
    const pollIntervalMs = Math.max(25, Math.floor(input.pollIntervalMs ?? this.pollIntervalMs));
    const allowManualFallback = input.allowManualFallback ?? this.allowManualFallback;
    const useHeadless = shouldUseHeadlessVerificationBrowser(this.sliderMode, this.headless);
    // The identity page polls Xianyu from its own JS; a minimized/off-screen
    // window gets its timers throttled by Chrome, so never hide it.
    const hideWindow = kind === 'slider' && shouldHideVerificationWindow(this.sliderMode, useHeadless, allowManualFallback);
    const releaseProfileLock = await acquireXianyuVerificationProfileLock(profileDir, maxWaitMs);
    try {
      const context = await this.browserFactory.launchPersistentContext({
        profileDir,
        headless: useHeadless,
        hideWindow,
        executablePath: this.executablePath,
        userAgent: this.userAgent,
        proxy: patchrightProxyFor(input.proxyUrl),
      });
      try {
        await context.addInitScript({ content: buildAutomationEvasionScript() });
        const page = await this.reuseVerificationPage(context);
        const initialSnapshot = normalizeCookieSnapshot(input.initialCookieSnapshot) ?? [];
        if (initialSnapshot.length > 0) await context.addCookies(toBrowserCookies(initialSnapshot, input.verificationUrl));
        await page.goto(input.verificationUrl, { waitUntil: 'domcontentloaded', timeout: maxWaitMs });
        await waitForPageContent(page, Math.min(maxWaitMs, 12_000), pollIntervalMs);
        await sleep(750);

        if (kind === 'identity') {
          console.info(JSON.stringify({ component: 'xianyu-verification', event: 'identity_verification_wait', maxWaitMs, hideWindow, headless: useHeadless }));
        } else if (this.sliderMode === 'auto') {
          const sliderResult = await new XianyuSliderSolver(page, {
            maxRetries: this.sliderMaxRetries,
            logger: console,
          }).solve();
          if (!sliderResult.success) {
            const reason = sliderResult.failureReason ?? 'unknown';
            console.warn(JSON.stringify({ component: 'xianyu-verification', event: 'slider_auto_solve_failed', reason, attempts: sliderResult.attempts, distance: sliderResult.distance, trajectoryPoints: sliderResult.trajectoryPoints }));
            if (!allowManualFallback) throw new Error(`XIANYU_VERIFICATION_AUTO_SOLVE_FAILED:${reason}`);
            console.warn(JSON.stringify({ component: 'xianyu-verification', event: 'slider_manual_fallback_wait', reason }));
          } else {
            console.info(JSON.stringify({ component: 'xianyu-verification', event: 'slider_auto_solve_succeeded', attempts: sliderResult.attempts, distance: sliderResult.distance, trajectoryPoints: sliderResult.trajectoryPoints }));
          }
        }

        const deadline = Date.now() + maxWaitMs;
        let lastUrl = page.url();
        let lastCookies = await context.cookies();
        while (Date.now() < deadline) {
          lastUrl = page.url();
          lastCookies = await context.cookies();
          if (isVerificationPageComplete(lastUrl, lastCookies, initialSnapshot, kind)) {
            await sleep(1_000);
            lastUrl = page.url();
            lastCookies = await context.cookies();
            if (isVerificationPageComplete(lastUrl, lastCookies, initialSnapshot, kind)) {
              console.info(JSON.stringify({ component: 'xianyu-verification', event: 'verification_completed', kind, finalUrl: lastUrl }));
              return { finalUrl: lastUrl, cookieSnapshot: dropStaleCaptchaChallengeCookies(mapCookies(lastCookies)) };
            }
          }
          if (isBlankOrInvalidVerificationPage(lastUrl)) throw new Error('XIANYU_VERIFICATION_PAGE_EMPTY');
          await sleep(pollIntervalMs);
        }
        console.warn(JSON.stringify({ component: 'xianyu-verification', event: 'verification_timeout', kind, lastUrl, maxWaitMs }));
        throw new Error('XIANYU_VERIFICATION_TIMEOUT');
      } finally {
        await closeVerificationPages(context);
        await context.close().catch(() => undefined);
      }
    } finally {
      await releaseProfileLock();
    }
  }

  private async resolveProfileDir(profileKey = 'default'): Promise<string> {
    const root = resolve(this.configuredUserDataDir ?? resolveDefaultVerificationUserDataDir());
    const safeKey = sanitizeProfileKey(profileKey);
    const profileDir = join(root, safeKey);
    await mkdir(profileDir, { recursive: true });
    return profileDir;
  }

  private async reuseVerificationPage(context: XianyuVerificationContext): Promise<XianyuVerificationPage> {
    const pages = context.pages();
    const page = pages[0] ?? await context.newPage();
    for (const extra of pages.slice(1)) await extra.close().catch(() => undefined);
    return page;
  }
}

async function closeVerificationPages(context: XianyuVerificationContext): Promise<void> {
  let pages: readonly XianyuVerificationPage[] = [];
  try {
    pages = context.pages();
  } catch {
    return;
  }
  for (const page of pages) await page.close().catch(() => undefined);
}

export function shouldUseHeadlessVerificationBrowser(sliderMode: XianyuSliderMode, configuredHeadless: boolean): boolean {
  if (configuredHeadless) return true;
  return sliderMode === 'auto' && process.env.XIANYU_VERIFICATION_AUTO_HEADLESS === 'true';
}

export function shouldHideVerificationWindow(sliderMode: XianyuSliderMode, useHeadless: boolean, allowManualFallback = false): boolean {
  return sliderMode === 'auto' && !useHeadless && !allowManualFallback;
}

export function resolveVerificationCookieUrl(verificationUrl: string): string {
  const url = new URL(verificationUrl);
  url.hash = '';
  url.search = '';
  if (!url.pathname) url.pathname = '/';
  return url.toString();
}

export function classifyVerificationUrl(value: string): XianyuVerificationKind {
  return isIdentityVerificationUrl(value) ? 'identity' : 'slider';
}

export function isIdentityVerificationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const path = url.pathname.toLowerCase();
    return path.includes('/iv/') || url.searchParams.has('havana_iv_token') || /mini_login_check|identity_verify|ivchecklogin/.test(path);
  } catch {
    return false;
  }
}

export function isVerificationPageComplete(finalUrl: string, cookies: XianyuCookieSnapshot, initialCookies: XianyuCookieSnapshot = [], kind: XianyuVerificationKind = 'slider'): boolean {
  if (kind === 'identity') {
    // The identity page finishes the login itself: `unb` only appears once the
    // phone-side verification succeeded and the PC page followed ivCheckLogin.
    const current = cookies.find((cookie) => cookie.name.toLowerCase() === 'unb' && cookie.value.trim());
    if (!current) return false;
    const initial = initialCookies.find((cookie) => cookie.name.toLowerCase() === 'unb' && cookie.value.trim());
    return !initial || initial.value !== current.value;
  }
  if (!isPostVerificationUrl(finalUrl)) return false;
  const current = cookies.find((cookie) => cookie.name.toLowerCase() === 'x5sec' && cookie.value.trim());
  if (!current) return false;
  const initial = initialCookies.find((cookie) => cookie.name.toLowerCase() === 'x5sec');
  return !initial || initial.value !== current.value;
}

function isPostVerificationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return !/captcha|punish|verify|security/i.test(`${url.pathname}${url.search}${url.hash}`);
  } catch {
    return false;
  }
}

function isBlankOrInvalidVerificationPage(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol !== 'http:' && url.protocol !== 'https:';
  } catch {
    return true;
  }
}

async function waitForPageContent(page: XianyuVerificationPage, maxWaitMs: number, pollIntervalMs: number): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const body = document.body;
      const html = document.documentElement;
      const text = body?.innerText?.trim() ?? '';
      const renderedNode = body?.querySelector('iframe,canvas,svg,img,video,object,embed,main,section,form,[class],[id],[role]');
      const meaningfulMarkup = (body?.innerHTML?.trim().length ?? 0) > 48 || (html?.outerHTML?.length ?? 0) > 220;
      return { ready: document.readyState !== 'loading', blank: !body || (!text && !renderedNode && !meaningfulMarkup) };
    }).catch(() => ({ ready: false, blank: true }));
    if (state.ready && !state.blank) return;
    await sleep(pollIntervalMs);
  }
  throw new Error('XIANYU_VERIFICATION_PAGE_EMPTY');
}

function toBrowserCookies(snapshot: XianyuCookieSnapshot, verificationUrl: string): XianyuVerificationCookie[] {
  const cookieUrl = resolveVerificationCookieUrl(verificationUrl);
  return snapshot.map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    ...(cookie.domain ? { domain: cookie.domain } : { url: cookieUrl }),
    path: cookie.path ?? '/',
    ...(cookie.expires !== undefined ? { expires: cookie.expires } : {}),
    ...(cookie.httpOnly !== undefined ? { httpOnly: cookie.httpOnly } : {}),
    ...(cookie.secure !== undefined ? { secure: cookie.secure } : {}),
    ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
  }));
}

function mergeSnapshots(current: XianyuCookieSnapshot, incoming: XianyuCookieSnapshot): XianyuCookieSnapshot {
  const identity = (cookie: XianyuCookieSnapshot[number]) => `${cookie.name.toLowerCase()}\u0000${(cookie.domain ?? '').toLowerCase()}\u0000${cookie.path ?? '/'}`;
  const merged = new Map<string, XianyuCookieSnapshot[number]>();
  for (const cookie of current) merged.set(identity(cookie), cookie);
  for (const cookie of incoming) {
    // A fresh x5* value supersedes the same cookie on any domain variant the
    // account already carried (e.g. h5api.m.goofish.com vs .goofish.com).
    for (const [key, existing] of merged) {
      if (existing.name.toLowerCase() === cookie.name.toLowerCase()) merged.delete(key);
    }
    merged.set(identity(cookie), cookie);
  }
  return [...merged.values()];
}

function mapCookies(cookies: Array<{ name: string; value: string; domain?: string; path?: string; expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: string }>): XianyuCookieSnapshot {
  return normalizeCookieSnapshot(cookies.map((cookie) => ({ ...cookie, sameSite: cookie.sameSite }))) ?? [];
}

function sanitizeProfileKey(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 96);
  return normalized || 'default';
}

function normalizeProfileLockKey(profileDir: string): string {
  const absolute = resolve(profileDir);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function buildAutomationEvasionScript(): string {
  return `(() => { try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true }); } catch {} })();`;
}

function assertVerificationUrl(value: string): void {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const isGoofishHost = hostname === 'goofish.com' || hostname.endsWith('.goofish.com') || hostname === 'localhost' || hostname === '127.0.0.1';
    const path = `${url.pathname}${url.search}${url.hash}`;
    const isLocalFixture = hostname === 'localhost' || hostname === '127.0.0.1';
    const isKnownChallengePath = /punish|captcha|verify|security/i.test(path) || isIdentityVerificationUrl(value);
    if (!isGoofishHost || (!isLocalFixture && !isKnownChallengePath)) throw new Error('invalid target');
  } catch {
    throw new Error('XIANYU_VERIFICATION_URL_INVALID');
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
