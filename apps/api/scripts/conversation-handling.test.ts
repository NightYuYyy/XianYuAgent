import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AutoReplyService } from '../src/auto-reply.js';

async function boot(label: string) {
  const runtime = createApp(loadConfig({
    ...process.env,
    AUTO_REPLY_AGENT_SEND_DELAY_SECONDS: '0',
    AUTO_REPLY_AGENT_DEBOUNCE_MS: '0',
    AUTO_REPLY_AGENT_REPLY_SEGMENT_DELAY_MS: '0',
    HOST: '127.0.0.1',
    PORT: '0',
    DATABASE_URL: '',
    REDIS_URL: '',
    ALLOW_IN_MEMORY: 'true',
    COOKIE_SECURE: 'false',
    XIANYU_QR_MODE: 'stub',
    AGENT_RUNTIME: 'in-process',
    AUTO_REPLY_MODEL_ENABLED: 'false',
    AUTO_REPLY_SEND_MODE: 'simulate',
    AUTOMATION_BUYER_ALLOWLIST: '["买家"]',
  }));
  await runtime.listen();
  const boot = await runtime.auth.bootstrap({ email: `${label}@example.com`, password: 'password-123', displayName: label });
  const account = await runtime.store.createAccount({ adminId: boot.admin.id, platform: 'xianyu', sellerRef: `${label}-seller` });
  const conversation = await runtime.store.createConversation({ adminId: boot.admin.id, accountId: account.id, buyerRef: `${label}-buyer`, buyerDisplayName: '买家', externalConversationRef: `${label}-conversation` });
  return { runtime, adminId: boot.admin.id, account, conversation };
}

const neverSend = { send: async () => { throw new Error('must not send'); } };

test('taking over a conversation flips handling mode, bumps version and makes auto-reply hand off', { concurrency: false }, async () => {
  const { runtime, adminId, conversation } = await boot('handling-mode');
  try {
    const before = await runtime.messages.getConversation(adminId, conversation.id);
    assert.equal(before.handlingMode, 'ai');
    const taken = await runtime.messages.setHandlingMode(adminId, conversation.id, 'human', 'req-1', 'trace-1');
    assert.equal(taken.handlingMode, 'human');
    assert.ok(taken.version > before.version, 'version must change so the web merge does not treat the update as stale');

    const inbound = (await runtime.messages.createMessage({ adminId, conversationId: conversation.id, direction: 'inbound', senderRole: 'buyer', bodyType: 'text', bodyText: '还能便宜点吗', requestId: 'req-2', traceId: 'trace-2' })).message;
    const service = new AutoReplyService(runtime.store, runtime.messages, async () => 'audit', {
      sendMode: 'simulate',
      buyerAllowlist: ['买家'],
      sendDelaySeconds: 0,
      generator: { generate: async () => '不该发出去的回复' },
      sender: neverSend,
    });
    const result = await service.processInbound({ adminId, conversationId: conversation.id, inboundMessageId: inbound.messageId, senderName: '买家' });
    assert.equal(result.run.status, 'handoff');
    assert.ok(result.run.riskFlags.includes('human_mode'));
    const outbound = (await runtime.messages.listMessages(adminId, conversation.id, { limit: 50 })).items.filter((message) => message.direction === 'outbound');
    assert.equal(outbound.length, 0);

    const back = await runtime.messages.setHandlingMode(adminId, conversation.id, 'ai', 'req-3', 'trace-3');
    assert.equal(back.handlingMode, 'ai');
    const same = await runtime.messages.setHandlingMode(adminId, conversation.id, 'ai', 'req-4', 'trace-4');
    assert.equal(same.version, back.version, 'a no-op switch must not bump the version');
    await assert.rejects(runtime.messages.setHandlingMode(adminId, conversation.id, 'bogus' as never, 'req-5', 'trace-5'), /mode must be/);
    await assert.rejects(runtime.messages.setHandlingMode(adminId, 'missing-conversation', 'human', 'req-6', 'trace-6'), /conversation not found/);
  } finally {
    await runtime.close();
  }
});

test('suggestReply drafts from the latest buyer message with the configured generator and never sends', { concurrency: false }, async () => {
  const { runtime, adminId, conversation } = await boot('suggest-reply');
  try {
    await assert.rejects(runtime.autoReply.suggestReply({ adminId, conversationId: conversation.id }), /没有买家消息/);
    await assert.rejects(runtime.autoReply.suggestReply({ adminId, conversationId: 'missing' }), /会话不存在/);

    await runtime.messages.createMessage({ adminId, conversationId: conversation.id, direction: 'inbound', senderRole: 'buyer', bodyType: 'text', bodyText: '有货吗', requestId: 'req-1', traceId: 'trace-1' });
    await runtime.messages.createMessage({ adminId, conversationId: conversation.id, direction: 'inbound', senderRole: 'buyer', bodyType: 'text', bodyText: '什么时候发货', requestId: 'req-2', traceId: 'trace-2' });

    const seen: string[] = [];
    const service = new AutoReplyService(runtime.store, runtime.messages, async () => 'audit', {
      sendMode: 'simulate',
      buyerAllowlist: ['买家'],
      maxReplyLength: 60,
      generator: {
        generate: async ({ context, classification }) => {
          seen.push(context.inboundMessage.bodyText ?? '');
          return { text: `建议回复：${classification.intent}，共 ${(context.pendingBuyerMessages ?? []).length} 条待回`, segments: ['建议回复'] };
        },
      },
      sender: neverSend,
    });
    const suggestion = await service.suggestReply({ adminId, conversationId: conversation.id });
    assert.deepEqual(seen, ['什么时候发货'], 'the latest buyer message anchors the draft');
    assert.equal(suggestion.decision, 'reply');
    assert.equal(suggestion.text, '建议回复：delivery，共 2 条待回');
    assert.equal(suggestion.intent, 'delivery');
    assert.deepEqual(suggestion.segments, ['建议回复']);
    const outbound = (await runtime.messages.listMessages(adminId, conversation.id, { limit: 50 })).items.filter((message) => message.direction === 'outbound');
    assert.equal(outbound.length, 0, 'a suggestion is a draft, nothing is sent');

    const skipping = new AutoReplyService(runtime.store, runtime.messages, async () => 'audit', {
      sendMode: 'simulate',
      buyerAllowlist: ['买家'],
      generator: { generate: async () => ({ text: '', decision: 'skip' as const, reason: 'already_answered' }) },
      sender: neverSend,
    });
    const skipped = await skipping.suggestReply({ adminId, conversationId: conversation.id });
    assert.deepEqual([skipped.decision, skipped.reason, skipped.text], ['skip', 'already_answered', '']);
  } finally {
    await runtime.close();
  }
});
