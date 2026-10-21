import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici';
import { HttpsProxyAgent } from 'https-proxy-agent';

/**
 * Per-account outbound proxy support.
 *
 * Xianyu's risk control weighs the egress IP heavily: a foreign server IP or
 * several accounts sharing one IP both raise the challenge rate. Every request
 * made on behalf of an account (MTOP, IM WebSocket + token refresh, QR login,
 * the verification browser) can therefore go through a proxy configured on
 * the account (`accounts.accounts.proxy_url`), falling back to
 * `XIANYU_DEFAULT_PROXY_URL` and finally to a direct connection.
 *
 * Only HTTP/HTTPS proxies are supported, optionally with basic auth:
 * `http://user:pass@host:port`.
 */

export interface ProxyCapableAccount {
  proxyUrl?: string;
}

export function normalizeProxyUrl(raw: string | undefined | null): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (!url.hostname) return undefined;
  if (url.search || url.hash) return undefined;
  if (url.pathname && url.pathname !== '/') return undefined;
  url.pathname = '';
  return url.toString().replace(/\/$/, '');
}

export function effectiveProxyUrl(account?: ProxyCapableAccount | null, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return normalizeProxyUrl(account?.proxyUrl) ?? normalizeProxyUrl(env.XIANYU_DEFAULT_PROXY_URL);
}

interface SplitProxy {
  server: string;
  username?: string;
  password?: string;
}

export function splitProxyUrl(proxyUrl: string): SplitProxy {
  const url = new URL(proxyUrl);
  const username = url.username ? decodeURIComponent(url.username) : undefined;
  const password = url.password ? decodeURIComponent(url.password) : undefined;
  url.username = '';
  url.password = '';
  url.pathname = '';
  return { server: url.toString().replace(/\/$/, ''), ...(username ? { username } : {}), ...(password ? { password } : {}) };
}

const dispatchers = new Map<string, ProxyAgent>();

export function proxyDispatcherFor(proxyUrl: string): Dispatcher {
  const existing = dispatchers.get(proxyUrl);
  if (existing) return existing;
  const { server, username, password } = splitProxyUrl(proxyUrl);
  const agent = new ProxyAgent({
    uri: server,
    ...(username ? { token: `Basic ${Buffer.from(`${username}:${password ?? ''}`).toString('base64')}` } : {}),
  });
  dispatchers.set(proxyUrl, agent);
  return agent;
}

/**
 * Returns a `fetch` that tunnels through the proxy, or the global fetch when
 * no proxy applies. The return type is the DOM `fetch` so call sites that use
 * `Response`/`Headers` keep compiling; undici's implementation is wire
 * compatible for everything this codebase reads (status, headers,
 * getSetCookie, json/text/arrayBuffer).
 */
export function proxiedFetchFor(proxyUrl?: string): typeof fetch {
  if (!proxyUrl) return globalThis.fetch.bind(globalThis);
  const dispatcher = proxyDispatcherFor(proxyUrl);
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => undiciFetch(input as never, { ...(init as object), dispatcher } as never) as unknown as Promise<Response>) as typeof fetch;
}

const wsAgents = new Map<string, HttpsProxyAgent<string>>();

/** `ws` needs an http.Agent that CONNECT-tunnels through the proxy. */
export function wsAgentFor(proxyUrl: string): HttpsProxyAgent<string> {
  const existing = wsAgents.get(proxyUrl);
  if (existing) return existing;
  const agent = new HttpsProxyAgent<string>(proxyUrl);
  wsAgents.set(proxyUrl, agent);
  return agent;
}

/** Playwright/Patchright `proxy` launch option. */
export function patchrightProxyFor(proxyUrl?: string): SplitProxy | undefined {
  const normalized = normalizeProxyUrl(proxyUrl);
  return normalized ? splitProxyUrl(normalized) : undefined;
}

/**
 * Resolves the effective proxy for an account with a short cache so hot paths
 * (every MTOP call) do not hit the database each time.
 */
export class AccountProxyResolver {
  private readonly cache = new Map<string, { value: string | undefined; expiresAt: number }>();

  constructor(
    private readonly loadAccount: (adminId: string, accountId: string) => Promise<ProxyCapableAccount | undefined>,
    private readonly ttlMs = 30_000,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly now: () => number = Date.now,
  ) {}

  async resolve(adminId: string, accountId: string): Promise<string | undefined> {
    const key = `${adminId}\u0000${accountId}`;
    const cached = this.cache.get(key);
    const now = this.now();
    if (cached && cached.expiresAt > now) return cached.value;
    let account: ProxyCapableAccount | undefined;
    try {
      account = await this.loadAccount(adminId, accountId);
    } catch {
      account = undefined;
    }
    const value = effectiveProxyUrl(account, this.env);
    this.cache.set(key, { value, expiresAt: now + this.ttlMs });
    return value;
  }

  invalidate(accountId?: string): void {
    if (!accountId) {
      this.cache.clear();
      return;
    }
    for (const key of this.cache.keys()) if (key.endsWith(`\u0000${accountId}`)) this.cache.delete(key);
  }
}
