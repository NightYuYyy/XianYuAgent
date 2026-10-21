import assert from 'node:assert/strict';
import test from 'node:test';
import { Notifier, createNotifierFromEnv, type NotificationChannel, type NotificationEvent } from '../src/notifier.js';

const quiet = { info: () => undefined, warn: () => undefined };

function recordingChannel(name: string, fail = false): NotificationChannel & { calls: Array<{ event: NotificationEvent; text: string }> } {
  const calls: Array<{ event: NotificationEvent; text: string }> = [];
  return {
    name,
    calls,
    async send(event, text) {
      calls.push({ event, text });
      if (fail) throw new Error('boom');
    },
  };
}

test('notifier renders a readable message and fans out to every channel', async () => {
  const a = recordingChannel('a');
  const b = recordingChannel('b');
  const notifier = new Notifier({ channels: [a, b], logger: quiet, now: () => Date.UTC(2026, 9, 21, 6, 30) });
  const result = await notifier.notify({ kind: 'order_paid', title: '新订单已付款', body: '商品：PPT Master\n金额：¥8.50', accountId: 'acc-1', accountLabel: '陈陈cc' });
  assert.deepEqual(result, { sent: ['a', 'b'], skipped: [], suppressed: false });
  assert.equal(a.calls.length, 1);
  assert.equal(a.calls[0]?.text, '[闲鱼] 新订单已付款\n账号：陈陈cc\n商品：PPT Master\n金额：¥8.50\n时间：2026/10/21 14:30:00');
});

test('a failing channel never blocks the others and never rejects', async () => {
  const bad = recordingChannel('bad', true);
  const good = recordingChannel('good');
  const notifier = new Notifier({ channels: [bad, good], logger: quiet });
  const result = await notifier.notify({ kind: 'system', title: 't' });
  assert.deepEqual(result.sent, ['good']);
  assert.deepEqual(result.skipped, ['bad']);
  notifier.fire({ kind: 'system', title: 'fire-and-forget' }); // must not throw
});

test('dedupe window suppresses repeats and kind filter drops unwanted events', async () => {
  const channel = recordingChannel('c');
  let clock = 1_000_000;
  const notifier = new Notifier({ channels: [channel], enabledKinds: ['account_verification_required'], dedupeMs: 60_000, logger: quiet, now: () => clock });
  const event: NotificationEvent = { kind: 'account_verification_required', title: '需要验证', accountId: 'acc', dedupeKey: 'risk:acc' };
  assert.equal((await notifier.notify(event)).suppressed, false);
  assert.equal((await notifier.notify(event)).suppressed, true);
  clock += 61_000;
  assert.equal((await notifier.notify(event)).suppressed, false);
  assert.equal(channel.calls.length, 2);
  const dropped = await notifier.notify({ kind: 'order_paid', title: 'ignored' });
  assert.deepEqual(dropped, { sent: [], skipped: [], suppressed: false });
  assert.equal(channel.calls.length, 2);
});

test('env wiring builds telegram, bark, wecom and webhook channels with the expected payloads', async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response('{"ok":true}', { status: 200 });
  };
  const notifier = createNotifierFromEnv({
    NOTIFY_TELEGRAM_BOT_TOKEN: 'token',
    NOTIFY_TELEGRAM_CHAT_ID: '12345',
    NOTIFY_BARK_URL: 'https://api.day.app/key/',
    NOTIFY_WECOM_WEBHOOK_URL: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k',
    NOTIFY_WEBHOOK_URL: 'https://hooks.example.com/xianyu',
    NOTIFY_EVENTS: 'order_paid,auto_reply_handoff',
    NOTIFY_DEDUPE_MINUTES: '0',
    NOTIFY_PREFIX: '[店]',
  }, fetchImpl, quiet);
  assert.deepEqual(notifier.status().channels, ['telegram', 'bark', 'wecom', 'webhook']);
  assert.deepEqual(notifier.status().enabledKinds, ['order_paid', 'auto_reply_handoff']);
  assert.equal(notifier.status().dedupeMs, 0);
  const result = await notifier.notify({ kind: 'order_paid', title: '付款', body: '详情', accountId: 'acc' });
  assert.deepEqual(result.sent, ['telegram', 'bark', 'wecom', 'webhook']);
  const byUrl = Object.fromEntries(requests.map((request) => [request.url, request.body]));
  assert.equal(byUrl['https://api.telegram.org/bottoken/sendMessage']?.chat_id, '12345');
  assert.equal(byUrl['https://api.day.app/key']?.title, '[店] 付款');
  assert.equal((byUrl['https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k']?.text as { content: string })?.content.startsWith('[店] 付款'), true);
  assert.equal(byUrl['https://hooks.example.com/xianyu']?.kind, 'order_paid');
  assert.equal(createNotifierFromEnv({}, fetchImpl, quiet).enabled, false);
});
