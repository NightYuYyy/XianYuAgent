import assert from 'node:assert/strict';
import test from 'node:test';
import { XianyuImService, confirmPartialDeliveryImage, matchRecentOutboundMessage } from '../src/xianyu-im-service.js';
import type { Store } from '../src/domain.js';
import type { XianyuMtopClient } from '../src/xianyu-mtop.js';
import type { MessageService } from '../src/messages.js';
import type { XianyuImClient } from '../src/xianyu-im.js';

const startedAt = new Date(Date.now() - 1_000).toISOString();

function historyMessage(input: { id: string; sender?: string; text?: string; imageUrl?: string; createdAt?: number }) {
  const data = input.imageUrl
    ? { contentType: 2, image: { pics: [{ url: input.imageUrl }] } }
    : { contentType: 1, text: { text: input.text } };
  return {
    message: {
      messageId: input.id,
      senderUserId: `${input.sender ?? 'seller'}@goofish`,
      createAt: input.createdAt ?? Date.now(),
      content: { custom: { data: Buffer.from(JSON.stringify(data)).toString('base64') } },
    },
  };
}

test('confirms a single outbound image after the send acknowledgement is lost', () => {
  assert.equal(matchRecentOutboundMessage([historyMessage({ id: 'image.PNM', imageUrl: 'https://example.test/image.png' })], ['seller'], {
    bodyType: 'image', content: 'https://example.test/image.png', startedAt,
  }), 'image.PNM');
});

test('does not accept inbound, stale, mismatched, or duplicate history as send proof', () => {
  const expected = { bodyType: 'text' as const, content: 'one-time-code', startedAt };
  assert.equal(matchRecentOutboundMessage([historyMessage({ id: 'buyer.PNM', sender: 'buyer', text: expected.content })], ['seller'], expected), undefined);
  assert.equal(matchRecentOutboundMessage([historyMessage({ id: 'old.PNM', text: expected.content, createdAt: Date.parse(startedAt) - 10_000 })], ['seller'], expected), undefined);
  assert.equal(matchRecentOutboundMessage([historyMessage({ id: 'just-before.PNM', text: expected.content, createdAt: Date.parse(startedAt) - 1 })], ['seller'], expected), undefined);
  assert.equal(matchRecentOutboundMessage([historyMessage({ id: 'other.PNM', text: 'other-code' })], ['seller'], expected), undefined);
  assert.equal(matchRecentOutboundMessage([
    historyMessage({ id: 'first.PNM', text: expected.content }),
    historyMessage({ id: 'second.PNM', text: expected.content }),
  ], ['seller'], expected), undefined);
});

test('partial delivery recovery requires the exact image and no later outbound content', () => {
  const image = historyMessage({ id: 'image.PNM', imageUrl: 'https://example.test/image.png' });
  const expected = { externalMessageRef: 'image.PNM', imageUrl: 'https://example.test/image.png', startedAt };
  assert.equal(confirmPartialDeliveryImage([image], ['seller'], expected), true);
  assert.equal(confirmPartialDeliveryImage([image, historyMessage({ id: 'text.PNM', text: 'card-code', createdAt: Date.now() + 1_000 })], ['seller'], expected), false);
  assert.equal(confirmPartialDeliveryImage([image], ['buyer'], expected), false);
  assert.equal(confirmPartialDeliveryImage([image], ['seller'], { ...expected, imageUrl: 'https://example.test/other.png' }), false);
});

test('image send accepted remotely then socket closes: history ACK completes without a second send', async () => {
  let sends = 0;
  let saved = 0;
  const url = 'https://example.test/upload.png';
  const store = { getConversation: async () => ({ accountId: 'account', externalConversationRef: 'conversation', buyerRef: 'buyer' }), withOutboundConversationLock: async (_account: string, _conversation: string, work: () => Promise<unknown>) => work() } as unknown as Store;
  const mtop = { uploadChatImage: async () => ({ success: true, url, width: 10, height: 10 }) } as unknown as XianyuMtopClient;
  const messages = { createMessage: async (input: { externalMessageRef?: string }) => { saved += 1; return { message: { externalMessageRef: input.externalMessageRef } }; } } as unknown as MessageService;
  const service = new XianyuImService(store, mtop, messages);
  const client = {
    selfUserIds: ['seller'],
    sendImage: async () => { sends += 1; throw new Error('xianyu IM connection closed'); },
    listMessages: async () => ({ userMessageModels: [historyMessage({ id: 'confirmed.PNM', imageUrl: url })] }),
  } as unknown as XianyuImClient;
  const mutable = service as unknown as { ensureClient: () => Promise<XianyuImClient>; markAccountFailure: () => Promise<void>; clearImSendRisk: () => Promise<void> };
  mutable.ensureClient = async () => client;
  mutable.markAccountFailure = async () => undefined;
  mutable.clearImSendRisk = async () => undefined;
  const result = await service.sendImage('admin', 'account', 'conversation-id', { filename: 'card.png', contentType: 'image/png', data: Buffer.from('card') }, 'request', 'trace') as { externalMessageRef?: string };
  assert.equal(result.externalMessageRef, 'confirmed.PNM');
  assert.equal(sends, 1);
  assert.equal(saved, 1);
});

test('unconfirmed text send stays unknown and is never blindly retried', async () => {
  let sends = 0;
  const store = { getConversation: async () => ({ accountId: 'account', externalConversationRef: 'conversation', buyerRef: 'buyer' }), withOutboundConversationLock: async (_account: string, _conversation: string, work: () => Promise<unknown>) => work() } as unknown as Store;
  const service = new XianyuImService(store, {} as XianyuMtopClient, {} as MessageService);
  const client = {
    selfUserIds: ['seller'],
    sendText: async () => { sends += 1; throw new Error('xianyu IM connection closed'); },
    listMessages: async () => ({ userMessageModels: [] }),
  } as unknown as XianyuImClient;
  const mutable = service as unknown as { ensureClient: () => Promise<XianyuImClient>; markAccountFailure: () => Promise<void> };
  mutable.ensureClient = async () => client;
  mutable.markAccountFailure = async () => undefined;
  await assert.rejects(() => service.sendExternalText('admin', 'account', 'conversation-id', 'one-time-code', 'request', 'trace'), (error: { code?: string }) => error.code === 'XIANYU_IM_SEND_OUTCOME_UNKNOWN');
  assert.equal(sends, 1);
});

test('text delivered before socket close is confirmed from history without duplicate send', async () => {
  let sends = 0;
  const store = { getConversation: async () => ({ accountId: 'account', externalConversationRef: 'conversation', buyerRef: 'buyer' }), withOutboundConversationLock: async (_account: string, _conversation: string, work: () => Promise<unknown>) => work() } as unknown as Store;
  const service = new XianyuImService(store, {} as XianyuMtopClient, {} as MessageService);
  const client = {
    selfUserIds: ['seller'],
    sendText: async () => { sends += 1; throw new Error('xianyu IM connection closed'); },
    listMessages: async () => ({ userMessageModels: [historyMessage({ id: 'text.PNM', text: 'one-time-code' })] }),
  } as unknown as XianyuImClient;
  const mutable = service as unknown as { ensureClient: () => Promise<XianyuImClient>; markAccountFailure: () => Promise<void>; clearImSendRisk: () => Promise<void> };
  mutable.ensureClient = async () => client;
  mutable.markAccountFailure = async () => undefined;
  mutable.clearImSendRisk = async () => undefined;
  assert.deepEqual(await service.sendExternalText('admin', 'account', 'conversation-id', 'one-time-code', 'request', 'trace'), { externalMessageRef: 'text.PNM' });
  assert.equal(sends, 1);
});

test('accepted send with missing message reference is reconciled before local success', async () => {
  const url = 'https://example.test/upload.png';
  const store = { getConversation: async () => ({ accountId: 'account', externalConversationRef: 'conversation', buyerRef: 'buyer' }), withOutboundConversationLock: async (_account: string, _conversation: string, work: () => Promise<unknown>) => work() } as unknown as Store;
  const mtop = { uploadChatImage: async () => ({ success: true, url, width: 10, height: 10 }) } as unknown as XianyuMtopClient;
  const messages = { createMessage: async (input: { externalMessageRef?: string }) => ({ message: { externalMessageRef: input.externalMessageRef } }) } as unknown as MessageService;
  const service = new XianyuImService(store, mtop, messages);
  const client = {
    selfUserIds: ['seller'],
    sendImage: async () => ({ externalMessageRef: undefined }),
    listMessages: async () => ({ userMessageModels: [historyMessage({ id: 'image.PNM', imageUrl: url })] }),
  } as unknown as XianyuImClient;
  const mutable = service as unknown as { ensureClient: () => Promise<XianyuImClient>; clearImSendRisk: () => Promise<void> };
  mutable.ensureClient = async () => client;
  mutable.clearImSendRisk = async () => undefined;
  const result = await service.sendImage('admin', 'account', 'conversation-id', { filename: 'card.png', contentType: 'image/png', data: Buffer.from('card') }, 'request', 'trace') as { externalMessageRef?: string };
  assert.equal(result.externalMessageRef, 'image.PNM');
});
