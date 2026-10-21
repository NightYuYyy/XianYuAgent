import { proxiedFetchFor } from './xianyu-proxy.js';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import {
  applySetCookies,
  cookieHeaderForUrl,
  cookieValue,
  cookieHeaderFromSnapshot,
  setCookieValues,
  XIANYU_TOP_SITE,
  type XianyuCookieSnapshot,
} from './xianyu-cookie-jar.js';
import { isIdentityVerificationUrl, type XianyuVerificationBrowser } from './xianyu-verification-browser.js';
import { XIANYU_USER_AGENT, xianyuNavigatorPlatform } from './xianyu-browser-identity.js';

const APP_KEY = '34839810';
const PASSPORT_HOST = 'https://passport.goofish.com';
const API_H5TK = 'https://h5api.m.goofish.com/h5/mtop.gaia.nodejs.gaia.idle.data.gw.v2.index.get/1.0/';
const API_MINI_LOGIN = `${PASSPORT_HOST}/mini_login.htm`;
const API_GENERATE_QR = `${PASSPORT_HOST}/newlogin/qrcode/generate.do`;
const API_SCAN_STATUS = `${PASSPORT_HOST}/newlogin/qrcode/query.do`;
const QR_VERIFY_TARGET = 'https://www.goofish.com/im';
const USER_AGENT = XIANYU_USER_AGENT;
/** How long a session may stay alive after Xianyu asks for a second factor. */
const VERIFICATION_EXTENSION_MS = 10 * 60_000;

export type XianyuQrStatus = 'waiting' | 'scanned' | 'succeeded' | 'expired' | 'cancelled' | 'failed' | 'verification_required';

export interface XianyuQrPublicSession {
  sessionId: string;
  accountId?: string;
  status: XianyuQrStatus;
  qrImageDataUrl?: string;
  expiresAt: string;
  pollAfterMs: number;
  errorCode?: string;
  verificationUrl?: string;
  verificationAutoLaunch?: boolean;
  /** Face-verification QR (Havana IV) for the buyer to scan with the Xianyu app. */
  faceQrImageDataUrl?: string;
}

export type XianyuQrStatusEvent = XianyuQrPublicSession & { adminId: string };

export interface XianyuQrSuccess {
  sessionId: string;
  adminId: string;
  accountId?: string;
  cookieHeader: string;
  cookieSnapshot: XianyuCookieSnapshot;
  unb: string;
}

export interface XianyuQrAdapterOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  onSuccess?: (result: XianyuQrSuccess) => Promise<void>;
  onStatus?: (session: XianyuQrStatusEvent) => Promise<void>;
  verificationBrowser?: XianyuVerificationBrowser;
  /** Automatic slider mode must not fall back to a visible/manual window. */
  allowManualVerificationFallback?: boolean;
  /** Effective outbound proxy for the (re)authorised account; undefined = direct. */
  resolveProxy?: (adminId: string, accountId?: string) => Promise<string | undefined>;
}

type CookieJar = XianyuCookieSnapshot;
type LoginParams = Record<string, string>;

interface InternalSession {
  sessionId: string;
  accountId?: string;
  adminId: string;
  createdAt: number;
  expiresAt: number;
  status: XianyuQrStatus;
  qrImageDataUrl?: string;
  qrParams: LoginParams;
  jar: CookieJar;
  errorCode?: string;
  verificationUrl?: string;
  completionNotified: boolean;
  proxyUrl?: string;
  faceQrImageDataUrl?: string;
}

export class XianyuQrLoginAdapter {
  private readonly sessions = new Map<string, InternalSession>();
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxWaitMs: number;
  private readonly onSuccess?: XianyuQrAdapterOptions['onSuccess'];
  private readonly onStatus?: XianyuQrAdapterOptions['onStatus'];
  private readonly verificationBrowser?: XianyuVerificationBrowser;
  private readonly allowManualVerificationFallback: boolean;
  private readonly resolveProxy?: XianyuQrAdapterOptions['resolveProxy'];

  constructor(options: XianyuQrAdapterOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 25_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_500;
    this.maxWaitMs = options.maxWaitMs ?? 5 * 60_000;
    this.onSuccess = options.onSuccess;
    this.onStatus = options.onStatus;
    this.verificationBrowser = options.verificationBrowser;
    this.allowManualVerificationFallback = options.allowManualVerificationFallback ?? true;
    this.resolveProxy = options.resolveProxy;
  }

  async create(input: { sessionId: string; adminId: string; accountId?: string }): Promise<XianyuQrPublicSession> {
    const previous = this.sessions.get(input.sessionId);
    if (previous) {
      // Renewal reuses the persisted login-session id. Mark the previous
      // in-memory session terminal before replacing it so its monitor can
      // stop even if it is between polls.
      previous.status = 'cancelled';
      previous.errorCode = 'QR_REPLACED';
    }
    const now = Date.now();
    const session: InternalSession = {
      sessionId: input.sessionId,
      accountId: input.accountId,
      adminId: input.adminId,
      createdAt: now,
      expiresAt: now + this.maxWaitMs,
      status: 'waiting',
      qrParams: {},
      jar: [],
      completionNotified: false,
    };
    this.sessions.set(session.sessionId, session);
    try {
      session.proxyUrl = await this.resolveProxy?.(input.adminId, input.accountId);
      await this.getMh5Token(session);
      await this.getLoginParams(session);
      const result = await this.generateQr(session);
      void this.monitor(session.sessionId);
      await this.emitStatus(session);
      return result;
    } catch (error) {
      session.status = 'failed';
      session.errorCode = classifyError(error);
      await this.emitStatus(session);
      throw error;
    }
  }

  get(sessionId: string): XianyuQrPublicSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (Date.now() >= session.expiresAt && !['succeeded', 'cancelled', 'failed'].includes(session.status)) {
      session.status = 'expired';
      session.errorCode = 'QR_EXPIRED';
    }
    return this.toPublic(session);
  }

  cancel(sessionId: string): XianyuQrPublicSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (!['succeeded', 'expired', 'failed'].includes(session.status)) session.status = 'cancelled';
    return this.toPublic(session);
  }

  private async monitor(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const deadline = Date.now() + this.maxWaitMs;
    let lastStatus = session.status;
    while (Date.now() < deadline && !['succeeded', 'expired', 'cancelled', 'failed'].includes(session.status)) {
      if (!this.isCurrent(session)) return;
      try {
        const result = await this.pollQrStatus(session);
        // A renewal may have replaced this session while the HTTP request was
        // in flight. Never let the old QR overwrite the new QR's state.
        if (!this.isCurrent(session)) return;
        if (result.status === 'SCANNED' || result.status === 'SCANED') session.status = 'scanned';
        else if (result.status === 'EXPIRED') { session.status = 'expired'; session.errorCode = 'QR_EXPIRED'; }
        else if (result.status === 'CANCELED') { session.status = 'cancelled'; session.errorCode = 'QR_CANCELLED'; }
        else if (result.status === 'ERROR') { session.status = 'failed'; session.errorCode = 'QR_PROVIDER_ERROR'; }
        else if (result.status === 'CONFIRMED') {
          if (result.iframeRedirect && result.iframeRedirectUrl) {
            session.status = 'verification_required';
            session.verificationUrl = result.iframeRedirectUrl;
            session.errorCode = 'VERIFICATION_REQUIRED';
            // The phone-side verification (人脸/短信) regularly outlives the
            // original QR window; keep the session alive while the server-side
            // verification page waits for it, otherwise `get()` reports
            // QR_EXPIRED while the login is still completing.
            session.expiresAt = Math.max(session.expiresAt, Date.now() + VERIFICATION_EXTENSION_MS);
            await this.emitStatus(session);
            if (isIdentityVerificationUrl(result.iframeRedirectUrl)) {
              // Replay the identity-verification pages over HTTP so the face QR can be
              // shown to the user; the server-side browser cannot be scanned.
              const outcome = await this.runFaceVerification(session, result.iframeRedirectUrl);
              if (outcome !== 'unsupported') return;
              if (!this.isCurrent(session)) return;
            }
            if (this.verificationBrowser?.enabled) {
              try {
                const completed = await this.verificationBrowser.waitForCompletion({
                  verificationUrl: result.iframeRedirectUrl,
                  profileKey: session.accountId ?? session.sessionId,
                  accountId: session.accountId,
                  proxyUrl: session.proxyUrl,
                  initialCookieSnapshot: session.jar,
                  allowManualFallback: this.allowManualVerificationFallback,
                });
                if (!this.isCurrent(session)) return;
                session.jar.splice(0, session.jar.length, ...mergeCookieSnapshots(session.jar, completed.cookieSnapshot));
                await this.completeConfirmedLogin(session);
                await this.emitStatus(session);
              } catch (error) {
                if (!this.isCurrent(session)) return;
                // Without the verification browser the login can never finish;
                // surface a terminal state with the real cause instead of
                // leaving the UI on "please complete verification" forever.
                session.status = 'failed';
                session.errorCode = classifyError(error);
                console.warn(JSON.stringify({ component: 'xianyu-qr', event: 'verification_failed', sessionId: session.sessionId, accountId: session.accountId, errorCode: session.errorCode, verificationUrl: result.iframeRedirectUrl }));
                await this.emitStatus(session);
              }
            }
            return;
          }
          await this.completeConfirmedLogin(session);
        }
        if (!this.isCurrent(session)) return;
        if (session.status !== lastStatus) {
          lastStatus = session.status;
          await this.emitStatus(session);
        }
        if (['succeeded', 'expired', 'cancelled', 'failed', 'verification_required'].includes(session.status)) return;
      } catch (error) {
        if (!this.isCurrent(session)) return;
        session.errorCode = classifyError(error);
        // A post-confirmation callback can fail after setting the in-memory
        // session to failed. Persist that terminal state immediately instead
        // of leaving the durable login session stuck at scanned forever.
        if (session.status === 'failed') {
          await this.emitStatus(session);
          return;
        }
        // 网络抖动不立即失败，继续等待到二维码超时。
      }
      if (!this.isCurrent(session)) return;
      await sleep(this.pollIntervalMs);
    }
    if (!this.isCurrent(session)) return;
    if (!['succeeded', 'expired', 'cancelled', 'failed', 'verification_required'].includes(session.status)) {
      session.status = 'expired';
      session.errorCode = 'QR_TIMEOUT';
      await this.emitStatus(session);
    }
  }

  /**
   * 人脸/短信二次验证（Havana IV）的纯 HTTP 复现，参照 xianyu-auto-reply 的实现：
   * 1. 跟随风控跳转落到 normal_validate.htm，取 htoken 与 verify_modes 链接
   * 2. 请求 verify_modes.htm，落到 identity_verify.htm，抠出人脸验证二维码内容
   * 3. 把二维码渲染给前端，用户用闲鱼 App 扫码刷脸
   * 4. 轮询 photoVerify/check.do 直到 code=3，再跟随 ivCheckLogin.htm 收 unb 等登录 Cookie
   *
   * 返回 'unsupported' 时调用方回退到服务端浏览器方案。
   */
  private async runFaceVerification(session: InternalSession, iframeUrl: string): Promise<'completed' | 'failed' | 'unsupported'> {
    const log = (event: string, extra: Record<string, unknown> = {}) => console.info(JSON.stringify({ component: 'xianyu-face-verification', event, sessionId: session.sessionId, accountId: session.accountId, ...extra }));
    let htoken: string | undefined;
    try {
      const landing = await this.fetchWithCookieRedirect(session, iframeUrl, documentHeaders());
      const landingUrl = landing.url || iframeUrl;
      const landingHtml = await landing.text();
      htoken = /htoken=([A-Za-z0-9_-]+)/u.exec(landingHtml)?.[1];
      let verifyModesUrl = /window\.location\.href\s*=\s*"(https:\/\/[^"]*?\/iv\/mini\/verify_modes\.htm\?[^"]*)"/u.exec(landingHtml)?.[1];
      if (!htoken || !verifyModesUrl) {
        log('landing_unrecognised', { landingUrl, htmlLength: landingHtml.length });
        return 'unsupported';
      }
      // The page appends window._iv_umidfg (always 1) to this link at runtime.
      if (verifyModesUrl.endsWith('_umidfg=')) verifyModesUrl += '1';
      const identity = await this.fetchWithCookieRedirect(session, verifyModesUrl, { ...documentHeaders(), referer: landingUrl });
      const identityHtml = await identity.text();
      const faceQrContent = /new\s+Qrcode\(\{\s*text:\s*"([^"]+)"/u.exec(identityHtml)?.[1];
      if (!faceQrContent) {
        log('face_qr_missing', { identityUrl: identity.url, htmlLength: identityHtml.length });
        return 'unsupported';
      }
      if (!this.isCurrent(session)) return 'failed';
      session.faceQrImageDataUrl = await QRCode.toDataURL(faceQrContent, { margin: 2, width: 320 });
      session.errorCode = 'FACE_VERIFICATION_REQUIRED';
      await this.emitStatus(session);
      log('face_qr_ready');
    } catch (error) {
      if (!this.isCurrent(session)) return 'failed';
      log('prepare_failed', { reason: error instanceof Error ? error.message : String(error) });
      return 'unsupported';
    }

    const checkUrl = `${PASSPORT_HOST}/iv/photoVerify/check.do?htoken=${encodeURIComponent(htoken)}`;
    const checkHeaders: Record<string, string> = {
      ...passportHeaders(),
      accept: 'application/json, text/javascript, */*; q=0.01',
      'x-requested-with': 'XMLHttpRequest',
      referer: `${PASSPORT_HOST}/iv/mini/identity_verify.htm?htoken=${htoken}`,
    };
    let ivCheckUrl: string | undefined;
    while (Date.now() < session.expiresAt) {
      if (!this.isCurrent(session)) return 'failed';
      try {
        const response = await this.requestFor(session, checkUrl, { method: 'GET', headers: { ...checkHeaders, cookie: cookieHeader(session.jar, checkUrl) } });
        absorbSetCookies(session.jar, checkUrl, response.headers);
        const payload = await response.json().catch(() => ({})) as { content?: { code?: unknown; url?: unknown } };
        const code = String(payload.content?.code ?? '');
        if (code === '3') {
          ivCheckUrl = normalizeUrl(String(payload.content?.url ?? ''));
          break;
        }
        if (code !== '0' && code !== '') log('check_unexpected', { code });
      } catch (error) {
        log('check_failed', { reason: error instanceof Error ? error.message : String(error) });
      }
      await sleep(2_000);
    }
    if (!this.isCurrent(session)) return 'failed';
    if (!ivCheckUrl) {
      session.status = 'expired';
      session.errorCode = 'FACE_VERIFICATION_TIMEOUT';
      session.faceQrImageDataUrl = undefined;
      await this.emitStatus(session);
      log('timeout');
      return 'failed';
    }
    try {
      const finished = await this.fetchWithCookieRedirect(session, ivCheckUrl, { ...documentHeaders(), referer: checkHeaders.referer });
      await finished.arrayBuffer();
      if (!this.isCurrent(session)) return 'failed';
      session.faceQrImageDataUrl = undefined;
      await this.completeConfirmedLogin(session);
      await this.emitStatus(session);
      log('completed', { status: session.status });
      return 'completed';
    } catch (error) {
      if (!this.isCurrent(session)) return 'failed';
      session.status = 'failed';
      session.errorCode = classifyError(error);
      session.faceQrImageDataUrl = undefined;
      await this.emitStatus(session);
      log('finish_failed', { errorCode: session.errorCode });
      return 'failed';
    }
  }

  private async getMh5Token(session: InternalSession): Promise<void> {
    const response = await this.requestFor(session, API_H5TK, { method: 'GET', headers: passportHeaders() });
    absorbSetCookies(session.jar, API_H5TK, response.headers);
    const data = '{"bizScene":"home"}';
    const timestamp = String(Date.now());
    const token = cookieValue(session.jar, '_m_h5_tk', API_H5TK).split('_', 1)[0];
    const params = new URLSearchParams({
      jsv: '2.7.2', appKey: APP_KEY, t: timestamp,
      sign: md5(`${token}&${timestamp}&${APP_KEY}&${data}`),
      v: '1.0', type: 'originaljson', dataType: 'json', timeout: '20000',
      api: 'mtop.gaia.nodejs.gaia.idle.data.gw.v2.index.get', data,
    });
    const post = await this.requestFor(session, `${API_H5TK}?${params.toString()}`, {
      method: 'POST', headers: { ...passportHeaders(), 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(session.jar, API_H5TK) },
    });
    absorbSetCookies(session.jar, API_H5TK, post.headers);
    if (!cookieValue(session.jar, '_m_h5_tk', API_H5TK)) throw new Error('QR_H5_TOKEN_INIT_FAILED');
  }

  private async getLoginParams(session: InternalSession): Promise<void> {
    const params = new URLSearchParams({ lang: 'zh_cn', appName: 'xianyu', appEntrance: 'web', styleType: 'vertical', bizParams: '', notLoadSsoView: 'false', notKeepLogin: 'false', isMobile: 'false', qrCodeFirst: 'false', stie: '77', rnd: String(Math.random()) });
    const url = `${API_MINI_LOGIN}?${params.toString()}`;
    const response = await this.requestFor(session, url, { method: 'GET', headers: { ...passportHeaders(), cookie: cookieHeader(session.jar, url) } });
    absorbSetCookies(session.jar, url, response.headers);
    const html = await response.text();
    const viewData = extractJsonAssignment(html, 'window.viewData') as Record<string, unknown>;
    const form = viewData.loginFormData;
    if (!form || typeof form !== 'object') throw new Error('QR_LOGIN_FORM_MISSING');
    session.qrParams = Object.fromEntries(Object.entries(form as Record<string, unknown>).map(([key, value]) => [key, value == null ? '' : String(value)]));
    session.qrParams.umidTag = 'SERVER';
  }

  private async generateQr(session: InternalSession): Promise<XianyuQrPublicSession> {
    const params = new URLSearchParams(session.qrParams);
    const url = `${API_GENERATE_QR}?${params.toString()}`;
    const response = await this.requestFor(session, url, { method: 'GET', headers: { ...passportHeaders(), cookie: cookieHeader(session.jar, url) } });
    absorbSetCookies(session.jar, url, response.headers);
    const payload = await response.json() as { content?: { success?: boolean; data?: { codeContent?: string; t?: string | number; ck?: string } } };
    const data = payload.content?.data;
    if (!payload.content?.success || !data?.codeContent) throw new Error('QR_GENERATE_FAILED');
    session.qrParams.t = String(data.t ?? '');
    session.qrParams.ck = String(data.ck ?? '');
    session.qrImageDataUrl = await QRCode.toDataURL(data.codeContent, { margin: 2, width: 360 });
    return this.toPublic(session);
  }

  private async pollQrStatus(session: InternalSession): Promise<{ status: string; iframeRedirect?: boolean; iframeRedirectUrl?: string }> {
    const form = new URLSearchParams({ ...session.qrParams, ua: '', navlanguage: 'zh-CN', navUserAgent: USER_AGENT, navPlatform: xianyuNavigatorPlatform(), isIframe: 'true', documentReferer: QR_VERIFY_TARGET, defaultView: 'qrcode' });
    const response = await this.requestFor(session, API_SCAN_STATUS, { method: 'POST', headers: { ...passportHeaders(), 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(session.jar, API_SCAN_STATUS) }, body: form.toString() });
    absorbSetCookies(session.jar, API_SCAN_STATUS, response.headers);
    const payload = await response.json() as { hasError?: boolean; content?: { data?: { qrCodeStatus?: string; iframeRedirect?: boolean; iframeRedirectUrl?: string } } };
    if (payload.hasError) return { status: 'ERROR' };
    return { status: String(payload.content?.data?.qrCodeStatus ?? 'UNKNOWN'), iframeRedirect: Boolean(payload.content?.data?.iframeRedirect), iframeRedirectUrl: normalizeUrl(payload.content?.data?.iframeRedirectUrl ?? '') };
  }

  private async completeConfirmedLogin(session: InternalSession): Promise<void> {
    if (!this.isCurrent(session)) return;
    const response = await this.fetchWithCookieRedirect(session, QR_VERIFY_TARGET, documentHeaders());
    const finalUrl = response.url || QR_VERIFY_TARGET;
    absorbSetCookies(session.jar, finalUrl, response.headers);
    await response.arrayBuffer();
    const unb = cookieValue(session.jar, 'unb', finalUrl)
      || cookieValue(session.jar, 'unb', QR_VERIFY_TARGET)
      || cookieValue(session.jar, 'unb');
    if (!unb) throw new Error('QR_CONFIRMED_WITHOUT_UNB');
    try {
      if (!this.isCurrent(session)) return;
      if (!session.completionNotified) {
        session.completionNotified = true;
        if (this.onSuccess) await this.onSuccess({ sessionId: session.sessionId, adminId: session.adminId, accountId: session.accountId, cookieHeader: cookieHeaderFromSnapshot(session.jar), cookieSnapshot: session.jar.map((cookie) => ({ ...cookie })), unb });
      }
      session.status = 'succeeded';
      session.errorCode = undefined;
    } catch (error) {
      session.status = 'failed';
      session.errorCode = classifyError(error);
      throw error;
    }
  }

  private isCurrent(session: InternalSession): boolean {
    return this.sessions.get(session.sessionId) === session;
  }

  private async fetchWithCookieRedirect(session: InternalSession, initialUrl: string, headers: Record<string, string>): Promise<Response> {
    let currentUrl = initialUrl;
    const requestHeaders = { ...headers };
    for (let redirectCount = 0; redirectCount <= 10; redirectCount += 1) {
      if (!this.isCurrent(session)) throw new Error('QR_SESSION_REPLACED');
      requestHeaders.cookie = cookieHeader(session.jar, currentUrl);
      const response = await this.requestFor(session, currentUrl, { method: 'GET', headers: requestHeaders, redirect: 'manual' });
      absorbSetCookies(session.jar, currentUrl, response.headers);
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get('location');
      await response.arrayBuffer();
      if (!location) throw new Error('QR_REDIRECT_LOCATION_MISSING');
      requestHeaders.referer = currentUrl;
      currentUrl = new URL(location, currentUrl).toString();
    }
    throw new Error('QR_REDIRECT_LIMIT');
  }

  private toPublic(session: InternalSession): XianyuQrPublicSession {
    return { sessionId: session.sessionId, accountId: session.accountId, status: session.status, qrImageDataUrl: session.qrImageDataUrl, expiresAt: new Date(session.expiresAt).toISOString(), pollAfterMs: this.pollIntervalMs, errorCode: session.errorCode, verificationUrl: session.verificationUrl, faceQrImageDataUrl: session.faceQrImageDataUrl, ...(this.verificationBrowser?.enabled ? { verificationAutoLaunch: true } : {}) };
  }

  private async emitStatus(session: InternalSession): Promise<void> {
    if (this.onStatus) await this.onStatus({ ...this.toPublic(session), adminId: session.adminId });
  }

  private requestFor(session: InternalSession, url: string, init: RequestInit): Promise<Response> {
    return this.request(url, init, session.proxyUrl);
  }

  private async request(url: string, init: RequestInit, proxyUrl?: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await proxiedFetchFor(proxyUrl)(url, { ...init, redirect: init.redirect ?? 'follow', signal: controller.signal });
      if (!response.ok && response.status >= 500) throw new Error(`HTTP_${response.status}`);
      return response;
    } finally { clearTimeout(timeout); }
  }
}

function passportHeaders(): Record<string, string> {
  return { accept: 'application/json, text/plain, */*', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8', 'cache-control': 'no-cache', origin: PASSPORT_HOST, pragma: 'no-cache', referer: `${PASSPORT_HOST}/`, 'user-agent': USER_AGENT };
}

function documentHeaders(): Record<string, string> {
  return { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8', 'cache-control': 'no-cache', pragma: 'no-cache', referer: 'https://www.goofish.com/', 'user-agent': USER_AGENT };
}

function absorbSetCookies(jar: CookieJar, requestUrl: string, headers: Headers): void {
  const values = setCookieValues(headers);
  if (values.length > 0) jar.splice(0, jar.length, ...applySetCookies(jar, requestUrl, values, Date.now(), XIANYU_TOP_SITE));
}

function cookieHeader(jar: CookieJar, requestUrl: string): string { return cookieHeaderForUrl(jar, requestUrl, Date.now(), XIANYU_TOP_SITE); }
function mergeCookieSnapshots(current: CookieJar, incoming: CookieJar): CookieJar {
  const identity = (cookie: CookieJar[number]) => `${cookie.name}\u0000${(cookie.domain ?? '').toLowerCase()}\u0000${cookie.path ?? '/'}\u0000${cookie.partitionKey ?? ''}`;
  const merged = new Map<string, CookieJar[number]>();
  for (const cookie of current) merged.set(identity(cookie), cookie);
  for (const cookie of incoming) merged.set(identity(cookie), cookie);
  return [...merged.values()];
}
function md5(value: string): string { return crypto.createHash('md5').update(value).digest('hex'); }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function classifyError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
  if (/^[A-Z][A-Z0-9_:-]*$/.test(code)) return code;
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('QR_')) return message;
  // Verification browser failures carry their own diagnostic code (optionally
  // suffixed with a lower-case reason); keep it instead of masking it.
  if (/^XIANYU_[A-Z0-9_]+(?::[A-Za-z0-9_-]+)?$/.test(message)) return message;
  return 'QR_NETWORK_ERROR';
}
function normalizeUrl(raw: string): string | undefined { const value = String(raw ?? '').replaceAll('\\/', '/').trim(); if (!value) return undefined; return value.startsWith('//') ? `https:${value}` : new URL(value, PASSPORT_HOST).toString(); }

function extractJsonAssignment(html: string, marker: string): Record<string, unknown> {
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) throw new Error('QR_LOGIN_FORM_MISSING');
  const start = html.indexOf('{', markerIndex);
  if (start < 0) throw new Error('QR_LOGIN_FORM_MISSING');
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(html.slice(start, index + 1)) as Record<string, unknown>;
    }
  }
  throw new Error('QR_LOGIN_FORM_MALFORMED');
}
