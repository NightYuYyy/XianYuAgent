import { normalizeCookieSnapshot, type XianyuCookieSnapshot } from './xianyu-cookie-jar.js';

/**
 * Remote slider solver client.
 *
 * Xianyu's Baxia/NC slider rejects CDP-injected pointer events (`code=300,
 * sig=from bx`) no matter how human the trajectory looks; only OS-level input
 * from a real desktop passes reliably. This client hands the punish URL (and,
 * optionally, the account cookies so the resulting `x5sec` is bound to the
 * account) to an external solver such as a Windows box running a physical
 * mouse engine, and receives the fresh `x5*` cookies back.
 *
 * The wire protocol is the one used by xianyu-auto-reply's
 * `/api/v1/captcha/slider-solve`, so any solver speaking that protocol works:
 *
 *   POST {secret_key, account_id, url, browser_timeout, cookies?, device_id?}
 *   -> {success: true,  data: {cookies: {x5sec: '...'}}}
 *   -> {success: false, message, data?: {url_expired?: true}}
 */
export interface XianyuRemoteSliderOptions {
  url: string;
  secret: string;
  /** Whole-request budget; the remote may spend most of it driving a browser. */
  timeoutMs?: number;
  /** Browser budget hint forwarded to the remote solver, in seconds. */
  browserTimeoutSeconds?: number;
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, 'info' | 'warn'>;
}

export interface XianyuRemoteSliderInput {
  verificationUrl: string;
  accountId?: string;
  /** Cookie header of the account that hit the challenge; forwarded so x5sec binds to it. */
  cookieHeader?: string;
  deviceId?: string;
}

export interface XianyuRemoteSliderResult {
  cookies: Record<string, string>;
  elapsedMs: number;
}

export const REMOTE_SLIDER_UNAVAILABLE = 'XIANYU_REMOTE_SLIDER_UNAVAILABLE';
export const REMOTE_SLIDER_UNAUTHORIZED = 'XIANYU_REMOTE_SLIDER_UNAUTHORIZED';
export const REMOTE_SLIDER_URL_EXPIRED = 'XIANYU_REMOTE_SLIDER_URL_EXPIRED';
export const REMOTE_SLIDER_REJECTED = 'XIANYU_REMOTE_SLIDER_REJECTED';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_BROWSER_TIMEOUT_SECONDS = 60;

export class XianyuRemoteSliderSolver {
  private readonly url: string;
  private readonly secret: string;
  private readonly timeoutMs: number;
  private readonly browserTimeoutSeconds: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Pick<Console, 'info' | 'warn'>;

  constructor(options: XianyuRemoteSliderOptions) {
    this.url = options.url.trim();
    this.secret = options.secret.trim();
    this.timeoutMs = Math.max(5_000, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    this.browserTimeoutSeconds = Math.max(20, Math.floor(options.browserTimeoutSeconds ?? DEFAULT_BROWSER_TIMEOUT_SECONDS));
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger ?? console;
  }

  get enabled(): boolean {
    return Boolean(this.url && this.secret);
  }

  async solve(input: XianyuRemoteSliderInput): Promise<XianyuRemoteSliderResult> {
    if (!this.enabled) throw new Error(REMOTE_SLIDER_UNAVAILABLE);
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const payload: Record<string, unknown> = {
      secret_key: this.secret,
      account_id: input.accountId ?? 'unknown',
      url: input.verificationUrl,
      browser_timeout: this.browserTimeoutSeconds,
    };
    if (input.cookieHeader) {
      payload.cookies = input.cookieHeader;
      payload.device_id = input.deviceId ?? '';
    }
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      this.logger.warn(JSON.stringify({ component: 'xianyu-remote-slider', event: 'remote_unreachable', accountId: input.accountId, elapsedMs: Date.now() - started, reason: error instanceof Error ? error.name : String(error) }));
      throw new Error(REMOTE_SLIDER_UNAVAILABLE);
    }
    clearTimeout(timer);
    if (response.status === 401 || response.status === 403) throw new Error(REMOTE_SLIDER_UNAUTHORIZED);
    if (response.status >= 500) throw new Error(REMOTE_SLIDER_UNAVAILABLE);
    let body: { success?: boolean; message?: string; data?: { cookies?: Record<string, unknown>; url_expired?: boolean } | null };
    try {
      body = await response.json() as typeof body;
    } catch {
      throw new Error(REMOTE_SLIDER_UNAVAILABLE);
    }
    const elapsedMs = Date.now() - started;
    const cookies = normalizeCookies(body.data?.cookies);
    if (body.success && Object.keys(cookies).length > 0) {
      this.logger.info(JSON.stringify({ component: 'xianyu-remote-slider', event: 'remote_solved', accountId: input.accountId, elapsedMs, cookieNames: Object.keys(cookies) }));
      return { cookies, elapsedMs };
    }
    if (body.data?.url_expired) {
      this.logger.warn(JSON.stringify({ component: 'xianyu-remote-slider', event: 'remote_url_expired', accountId: input.accountId, elapsedMs }));
      throw new Error(REMOTE_SLIDER_URL_EXPIRED);
    }
    this.logger.warn(JSON.stringify({ component: 'xianyu-remote-slider', event: 'remote_rejected', accountId: input.accountId, elapsedMs, message: body.message ?? '' }));
    throw new Error(REMOTE_SLIDER_REJECTED);
  }
}

function normalizeCookies(raw: Record<string, unknown> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw ?? {})) {
    const key = name.trim();
    const text = typeof value === 'string' ? value.trim() : '';
    if (key && text) result[key] = text;
  }
  return result;
}

/**
 * The solver returns bare name/value pairs. Attach them to the Xianyu
 * top-level site so every goofish.com host (h5api, passport, www) sends them.
 */
export function remoteSliderCookiesToSnapshot(cookies: Record<string, string>, expiresAt?: number): XianyuCookieSnapshot {
  return normalizeCookieSnapshot(Object.entries(cookies).map(([name, value]) => ({
    name,
    value,
    domain: '.goofish.com',
    path: '/',
    secure: true,
    ...(expiresAt !== undefined ? { expires: expiresAt } : {}),
  }))) ?? [];
}

export function isRemoteSliderRetryableError(error: unknown): boolean {
  return error instanceof Error && error.message === REMOTE_SLIDER_UNAVAILABLE;
}
