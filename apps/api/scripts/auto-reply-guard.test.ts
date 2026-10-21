import assert from 'node:assert/strict';
import test from 'node:test';
import { AutoRateService, DefaultReplyFallbackGenerator, evaluateInboundPolicy, sanitizeReplyPolicy, validateReplyPolicy } from '../src/auto-reply-guard.js';
import type { AutoReplyContext } from '../src/auto-reply.js';
import type { AutoReplyPolicy, ConversationRecord, MessageRecord } from '../src/domain.js';

const basePolicy: AutoReplyPolicy = {
  messageFilters: [
    { id: 'f1', keyword: '加微信', matchMode: 'contains', skipReply: true, skipNotify: false, enabled: true },
    { id: 'f2', keyword: '^拼单', matchMode: 'regex', skipReply: false, skipNotify: true, enabled: true },
    { id: 'f3', keyword: '禁用', matchMode: 'contains', skipReply: true, skipNotify: true, enabled: false },
  ],
  blacklist: [
    { id: 'b1', buyerRef: 'bad-buyer', enabled: true },
    { id: 'b2', buyerRef: 'item-bound', itemRef: 'item-9', enabled: true },
  ],
  defaultReply: { enabled: true, content: '您好，在的～', replyOnce: true },
  autoRate: { enabled: true, content: '好买家' },
};

test('inbound policy blocks blacklisted buyers and filtered keywords, and only suppresses notifications when asked', () => {
  assert.equal(evaluateInboundPolicy(basePolicy, { buyerRef: 'bad-buyer', text: '在吗' }).action, 'blacklisted');
  assert.equal(evaluateInboundPolicy(basePolicy, { buyerRef: 'item-bound', itemRef: 'item-9', text: '在吗' }).action, 'blacklisted');
  assert.equal(evaluateInboundPolicy(basePolicy, { buyerRef: 'item-bound', itemRef: 'item-1', text: '在吗' }).action, 'allow', 'item-bound entries only apply to that item');
  const filtered = evaluateInboundPolicy(basePolicy, { buyerRef: 'ok', text: '可以 加 微信 聊吗' });
  assert.equal(filtered.action, 'filtered');
  assert.equal(filtered.skipNotify, false);
  const notifyOnly = evaluateInboundPolicy(basePolicy, { buyerRef: 'ok', text: '拼单一起买' });
  assert.deepEqual([notifyOnly.action, notifyOnly.skipNotify], ['allow', true]);
  assert.equal(evaluateInboundPolicy(basePolicy, { buyerRef: 'ok', text: '禁用这个词' }).action, 'allow', 'disabled filters are ignored');
  assert.equal(evaluateInboundPolicy(undefined, { buyerRef: 'ok', text: '任何' }).action, 'allow');
});

test('policy sanitizer tolerates junk and validator rejects impossible input', () => {
  const sanitized = sanitizeReplyPolicy({ messageFilters: [{ keyword: ' 微信 ', matchMode: 'weird' }, { keyword: '' }], blacklist: [{ buyerRef: ' 123 ' }, {}], defaultReply: { enabled: true }, autoRate: 'x' });
  assert.equal(sanitized.messageFilters.length, 1);
  assert.equal(sanitized.messageFilters[0]?.matchMode, 'contains');
  assert.equal(sanitized.blacklist.length, 1);
  assert.equal(sanitized.blacklist[0]?.buyerRef, '123');
  assert.equal(sanitized.autoRate.enabled, false);
  assert.throws(() => validateReplyPolicy({ messageFilters: [{ keyword: '(', matchMode: 'regex' }] }), /正则/);
  assert.throws(() => validateReplyPolicy({ defaultReply: { enabled: true, content: '' } }), /默认回复/);
  assert.equal(validateReplyPolicy(undefined).messageFilters.length, 0);
});

function makeContext(recent: Array<Partial<MessageRecord>> = []): AutoReplyContext {
  const conversation = { id: 'conv-1', accountId: 'acc-1', buyerRef: 'buyer-1', side: 'seller', handlingMode: 'ai', unreadCount: 0, version: 1, createdAt: 'now', updatedAt: 'now' } as ConversationRecord;
  const inbound = { id: 'm1', conversationId: 'conv-1', accountId: 'acc-1', direction: 'inbound', senderRole: 'buyer', bodyType: 'text', bodyText: '在吗' } as MessageRecord;
  return { conversation, inboundMessage: inbound, recentMessages: recent as AutoReplyContext['recentMessages'], orders: [] };
}

test('default reply fills in when the model skips or fails, but only once per conversation', async () => {
  const policy: AutoReplyPolicy = { ...basePolicy };
  const loader = async () => policy;
  const skipping = { generate: async () => ({ text: '', decision: 'skip' as const }) };
  const generator = new DefaultReplyFallbackGenerator(loader, skipping, { info() {}, warn() {} });
  const first = await generator.generate({ context: makeContext(), classification: { intent: 'unknown', confidence: 0, matchedRules: [] } as never });
  assert.deepEqual(first, { text: '您好，在的～', decision: 'reply', reason: 'default_reply' });
  const second = await generator.generate({ context: makeContext([{ direction: 'outbound', senderRole: 'agent', bodyText: '您好，在的～' }]), classification: {} as never });
  assert.equal((second as { decision?: string }).decision, 'skip', 'replyOnce keeps the model verdict after the default was sent');

  const failing = { generate: async () => { throw new Error('MODEL_DOWN'); } };
  const afterFailure = await new DefaultReplyFallbackGenerator(loader, failing, { info() {}, warn() {} }).generate({ context: makeContext(), classification: {} as never });
  assert.equal((afterFailure as { text: string }).text, '您好，在的～');

  const answering = { generate: async () => ({ text: '模型答复', decision: 'reply' as const }) };
  const normal = await new DefaultReplyFallbackGenerator(loader, answering).generate({ context: makeContext(), classification: {} as never });
  assert.equal((normal as { text: string }).text, '模型答复');
});

test('auto-rate rates a received order once and respects the account switch', async () => {
  const calls: string[] = [];
  const store = { getAutoReplyAgentConfig: async () => ({ replyPolicy: basePolicy }) as never };
  const xianyu = { rateOrder: async (_a: string, _b: string, orderNo: string, feedback: string) => { calls.push(`${orderNo}:${feedback}`); return { status: 'succeeded' as const }; } };
  const audits: string[] = [];
  const service = new AutoRateService(store, xianyu, async (input) => { audits.push(input.action); return 'a'; }, { info() {}, warn() {} });
  const event = { externalMessageRef: 'm1', bodyText: '买家已确认收货，交易成功，订单号：2345678901234567' };
  assert.equal(await service.onSystemMessage({ adminId: 'admin', accountId: 'acc', event, kind: 'received' }), 'rated');
  assert.equal(await service.onSystemMessage({ adminId: 'admin', accountId: 'acc', event, kind: 'received' }), 'skipped', 'deduped');
  assert.equal(await service.onSystemMessage({ adminId: 'admin', accountId: 'acc', event: { externalMessageRef: 'm2', bodyText: '买家已付款' }, kind: 'paid_waiting_shipment' }), 'skipped');
  assert.deepEqual(calls, ['2345678901234567:好买家']);
  assert.deepEqual(audits, ['order.auto_rated']);
  const disabled = new AutoRateService({ getAutoReplyAgentConfig: async () => ({ replyPolicy: { ...basePolicy, autoRate: { enabled: false, content: '' } } }) as never }, xianyu, async () => 'a', { info() {}, warn() {} });
  assert.equal(await disabled.onSystemMessage({ adminId: 'admin', accountId: 'acc', event: { externalMessageRef: 'm3', bodyText: '交易成功 订单号 9999999999999999' }, kind: 'trade_success' }), 'skipped');
});
