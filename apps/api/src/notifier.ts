/**
 * Outbound notifications (Telegram / Bark / 企业微信群机器人 / generic webhook).
 *
 * The seller is usually not watching the console. Anything that needs a human
 * (account challenged, listener gone, buyer handed off, delivery blocked) or
 * that they want to hear about (order paid) is pushed through every channel
 * configured in the environment. Sends are fire-and-forget and never throw
 * into the caller; a broken channel must not break order processing.
 *
 * Configuration (all optional; a channel is active when its variables are set):
 *   NOTIFY_TELEGRAM_BOT_TOKEN + NOTIFY_TELEGRAM_CHAT_ID
 *   NOTIFY_BARK_URL            e.g. https://api.day.app/<device-key>
 *   NOTIFY_WECOM_WEBHOOK_URL   企业微信群机器人 webhook
 *   NOTIFY_WEBHOOK_URL         POST JSON {kind,title,body,accountId,at}
 *   NOTIFY_EVENTS              comma list of kinds to send; default: all
 *   NOTIFY_DEDUPE_MINUTES      suppress repeats of the same dedupeKey; default 10
 *   NOTIFY_PREFIX              text prepended to every title; default "[闲鱼]"
 */
export type NotificationKind =
  | 'account_verification_required'
  | 'account_verification_cleared'
  | 'account_listener_stopped'
  | 'order_paid'
  | 'order_manual_review'
  | 'auto_reply_handoff'
  | 'remote_slider_failed'
  | 'system';

export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
  'account_verification_required',
  'account_verification_cleared',
  'account_listener_stopped',
  'order_paid',
  'order_manual_review',
  'auto_reply_handoff',
  'remote_slider_failed',
  'system',
];

export interface NotificationEvent {
  kind: NotificationKind;
  title: string;
  body?: string;
  accountId?: string;
  accountLabel?: string;
  /** Events sharing a dedupeKey are sent at most once per dedupe window. */
  dedupeKey?: string;
}

export interface NotificationChannel {
  readonly name: string;
  send(event: NotificationEvent, text: string): Promise<void>;
}

export interface NotifierOptions {
  channels: NotificationChannel[];
  enabledKinds?: readonly NotificationKind[];
  dedupeMs?: number;
  prefix?: string;
  logger?: Pick<Console, 'info' | 'warn'>;
  now?: () => number;
}

export interface NotifierStatus {
  channels: string[];
  enabledKinds: NotificationKind[];
  dedupeMs: number;
}

const DEFAULT_DEDUPE_MS = 10 * 60_000;
const DEFAULT_PREFIX = '[闲鱼]';
const SEND_TIMEOUT_MS = 10_000;

export class Notifier {
  private readonly channels: NotificationChannel[];
  private readonly enabledKinds: Set<NotificationKind>;
  private readonly dedupeMs: number;
  private readonly prefix: string;
  private readonly logger: Pick<Console, 'info' | 'warn'>;
  private readonly now: () => number;
  private readonly recent = new Map<string, number>();

  constructor(options: NotifierOptions) {
    this.channels = options.channels;
    this.enabledKinds = new Set(options.enabledKinds ?? NOTIFICATION_KINDS);
    this.dedupeMs = Math.max(0, options.dedupeMs ?? DEFAULT_DEDUPE_MS);
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
    this.logger = options.logger ?? console;
    this.now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.channels.length > 0;
  }

  status(): NotifierStatus {
    return { channels: this.channels.map((channel) => channel.name), enabledKinds: [...this.enabledKinds], dedupeMs: this.dedupeMs };
  }

  /** Fire-and-forget: resolves once every channel has been attempted; never rejects. */
  async notify(event: NotificationEvent): Promise<{ sent: string[]; skipped: string[]; suppressed: boolean }> {
    const result = { sent: [] as string[], skipped: [] as string[], suppressed: false };
    if (!this.enabled || !this.enabledKinds.has(event.kind)) return result;
    if (event.dedupeKey && this.dedupeMs > 0) {
      const last = this.recent.get(event.dedupeKey);
      const now = this.now();
      if (last !== undefined && now - last < this.dedupeMs) {
        result.suppressed = true;
        return result;
      }
      this.recent.set(event.dedupeKey, now);
      if (this.recent.size > 1_000) this.pruneRecent(now);
    }
    const text = this.render(event);
    await Promise.all(this.channels.map(async (channel) => {
      try {
        await withTimeout(channel.send(event, text), SEND_TIMEOUT_MS);
        result.sent.push(channel.name);
      } catch (error) {
        result.skipped.push(channel.name);
        this.logger.warn(JSON.stringify({ component: 'notifier', event: 'channel_send_failed', channel: channel.name, kind: event.kind, reason: error instanceof Error ? error.message : String(error) }));
      }
    }));
    this.logger.info(JSON.stringify({ component: 'notifier', event: 'notified', kind: event.kind, accountId: event.accountId, sent: result.sent, skipped: result.skipped }));
    return result;
  }

  /** Convenience wrapper for call sites that must not await or observe failures. */
  fire(event: NotificationEvent): void {
    void this.notify(event).catch(() => undefined);
  }

  render(event: NotificationEvent): string {
    const lines = [`${this.prefix} ${event.title}`.trim()];
    if (event.accountLabel || event.accountId) lines.push(`账号：${event.accountLabel ?? event.accountId}`);
    if (event.body) lines.push(event.body);
    lines.push(`时间：${formatTime(this.now())}`);
    return lines.join('\n');
  }

  private pruneRecent(now: number): void {
    for (const [key, at] of this.recent) if (now - at >= this.dedupeMs) this.recent.delete(key);
  }
}

// ---------------------------------------------------------------- channels

type FetchLike = typeof fetch;

export function telegramChannel(botToken: string, chatId: string, fetchImpl: FetchLike = fetch): NotificationChannel {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  return {
    name: 'telegram',
    async send(_event, text) {
      await expectOk(fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }) }));
    },
  };
}

export function barkChannel(baseUrl: string, fetchImpl: FetchLike = fetch): NotificationChannel {
  const endpoint = baseUrl.replace(/\/+$/, '');
  return {
    name: 'bark',
    async send(event, text) {
      const [title, ...rest] = text.split('\n');
      await expectOk(fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, body: rest.join('\n'), group: 'xianyu', level: event.kind === 'order_paid' ? 'active' : 'timeSensitive' }) }));
    },
  };
}

export function wecomChannel(webhookUrl: string, fetchImpl: FetchLike = fetch): NotificationChannel {
  return {
    name: 'wecom',
    async send(_event, text) {
      await expectOk(fetchImpl(webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ msgtype: 'text', text: { content: text } }) }));
    },
  };
}

export function webhookChannel(url: string, fetchImpl: FetchLike = fetch): NotificationChannel {
  return {
    name: 'webhook',
    async send(event, text) {
      await expectOk(fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: event.kind, title: event.title, body: event.body ?? '', accountId: event.accountId ?? null, accountLabel: event.accountLabel ?? null, text, at: new Date().toISOString() }) }));
    },
  };
}

// ---------------------------------------------------------------- env wiring

export interface NotifierEnv {
  NOTIFY_TELEGRAM_BOT_TOKEN?: string;
  NOTIFY_TELEGRAM_CHAT_ID?: string;
  NOTIFY_BARK_URL?: string;
  NOTIFY_WECOM_WEBHOOK_URL?: string;
  NOTIFY_WEBHOOK_URL?: string;
  NOTIFY_EVENTS?: string;
  NOTIFY_DEDUPE_MINUTES?: string;
  NOTIFY_PREFIX?: string;
}

export function createNotifierFromEnv(env: NotifierEnv = process.env as NotifierEnv, fetchImpl: FetchLike = fetch, logger?: Pick<Console, 'info' | 'warn'>): Notifier {
  const channels: NotificationChannel[] = [];
  const token = env.NOTIFY_TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.NOTIFY_TELEGRAM_CHAT_ID?.trim();
  if (token && chatId) channels.push(telegramChannel(token, chatId, fetchImpl));
  if (env.NOTIFY_BARK_URL?.trim()) channels.push(barkChannel(env.NOTIFY_BARK_URL.trim(), fetchImpl));
  if (env.NOTIFY_WECOM_WEBHOOK_URL?.trim()) channels.push(wecomChannel(env.NOTIFY_WECOM_WEBHOOK_URL.trim(), fetchImpl));
  if (env.NOTIFY_WEBHOOK_URL?.trim()) channels.push(webhookChannel(env.NOTIFY_WEBHOOK_URL.trim(), fetchImpl));
  const enabledKinds = parseKinds(env.NOTIFY_EVENTS);
  const dedupeMinutes = Number(env.NOTIFY_DEDUPE_MINUTES);
  return new Notifier({
    channels,
    enabledKinds,
    dedupeMs: Number.isFinite(dedupeMinutes) && dedupeMinutes >= 0 ? dedupeMinutes * 60_000 : undefined,
    prefix: env.NOTIFY_PREFIX?.trim() || undefined,
    logger,
  });
}

function parseKinds(raw: string | undefined): NotificationKind[] | undefined {
  const value = raw?.trim();
  if (!value || value.toLowerCase() === 'all') return undefined;
  const known = new Set<string>(NOTIFICATION_KINDS);
  const kinds = value.split(',').map((item) => item.trim()).filter((item): item is NotificationKind => known.has(item));
  return kinds.length > 0 ? kinds : undefined;
}

// ---------------------------------------------------------------- process-wide instance

let current: Notifier = new Notifier({ channels: [] });

/** Install the process-wide notifier (API and Worker each call this once at startup). */
export function configureNotifier(notifier: Notifier): Notifier {
  current = notifier;
  return current;
}

export function getNotifier(): Notifier {
  return current;
}

/** Fire-and-forget helper for call sites deep inside request/worker code. */
export function notify(event: NotificationEvent): void {
  current.fire(event);
}

// ---------------------------------------------------------------- helpers

async function expectOk(responsePromise: Promise<Response>): Promise<void> {
  const response = await responsePromise;
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  await response.arrayBuffer().catch(() => undefined);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('NOTIFY_TIMEOUT')), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}
