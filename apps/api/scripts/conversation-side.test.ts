import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryStore } from '../src/store-memory.js';
import { MessageService } from '../src/messages.js';
import { XianyuImService } from '../src/xianyu-im-service.js';
import { autoReplyAllowedForSide, ConversationSideResolver } from '../src/conversation-side.js';

async function setup(sellerRef = 'me-123') {
  const store = new MemoryStore();
  const admin = await store.createAdmin({ email: `side-${Math.random().toString(16).slice(2)}@example.com`, passwordHash: 'hash', displayName: 'Side' });
  const account = await store.createAccount({ adminId: admin.id, platform: 'xianyu', sellerRef });
  return { store, admin, account };
}

test('resolver treats a locally known listing as the seller side without calling the detail API', async () => {
  const { store, admin, account } = await setup();
  await store.createProduct({ adminId: admin.id, accountId: account.id, externalProductRef: 'item-mine', title: '我的商品', priceMinor: 100, requestId: 'r', traceId: 't' });
  let detailCalls = 0;
  const resolver = new ConversationSideResolver(store, { fetchItemDetail: async () => { detailCalls += 1; return { success: true, summary: { sellerId: 'someone-else' } }; } });
  assert.equal(await resolver.resolve({ adminId: admin.id, accountId: account.id, itemRef: 'item-mine' }), 'seller');
  assert.equal(detailCalls, 0);
});

test('resolver compares the item seller with the account identity and caches the verdict', async () => {
  const { store, admin, account } = await setup('me-123');
  const seen: string[] = [];
  const resolver = new ConversationSideResolver(store, {
    fetchItemDetail: async (_adminId, _accountId, itemId) => {
      seen.push(itemId);
      return { success: true, summary: { sellerId: itemId === 'item-mine' ? 'me-123' : 'other-seller' } };
    },
  });
  assert.equal(await resolver.resolve({ adminId: admin.id, accountId: account.id, itemRef: 'item-mine' }), 'seller');
  assert.equal(await resolver.resolve({ adminId: admin.id, accountId: account.id, itemRef: 'item-theirs' }), 'buyer');
  assert.equal(await resolver.resolve({ adminId: admin.id, accountId: account.id, itemRef: 'item-theirs' }), 'buyer');
  assert.deepEqual(seen, ['item-mine', 'item-theirs'], 'the second lookup of the same item is served from cache');
  assert.equal(await resolver.resolve({ adminId: admin.id, accountId: account.id }), 'unknown', 'no item means no verdict');
});

test('resolver reports unknown when the detail lookup fails or has no seller', async () => {
  const { store, admin, account } = await setup();
  const failing = new ConversationSideResolver(store, { fetchItemDetail: async () => { throw new Error('network'); } });
  assert.equal(await failing.resolve({ adminId: admin.id, accountId: account.id, itemRef: 'item-x' }), 'unknown');
  const empty = new ConversationSideResolver(store, { fetchItemDetail: async () => ({ success: true, summary: {} }) });
  assert.equal(await empty.resolve({ adminId: admin.id, accountId: account.id, itemRef: 'item-y' }), 'unknown');
  const noClient = new ConversationSideResolver(store, {});
  assert.equal(await noClient.resolve({ adminId: admin.id, accountId: account.id, itemRef: 'item-z' }), 'unknown');
  assert.equal(autoReplyAllowedForSide('unknown'), false);
  assert.equal(autoReplyAllowedForSide('buyer'), false);
  assert.equal(autoReplyAllowedForSide('seller'), true);
});

test('IM listener never auto-replies when the account is the buyer in the conversation', async () => {
  const { store, admin, account } = await setup('me-123');
  const messages = new MessageService(store, async () => 'audit');
  const autoReplyCalls: string[] = [];
  const autoReply = { processInbound: async () => { autoReplyCalls.push('called'); return undefined; } };
  const mtop = { fetchItemDetail: async (_a: string, _b: string, itemId: string) => ({ success: true, summary: { sellerId: itemId === 'item-mine' ? 'me-123' : 'other-seller' } }) };
  const service = new XianyuImService(store, mtop as never, messages, autoReply as never);

  const theirs = await service.handleExternalEvent(admin.id, {
    accountId: account.id, externalConversationRef: 'conv-theirs', externalMessageRef: 'theirs-1.PNM', senderRef: 'other-seller', senderName: '对方卖家',
    itemRef: 'item-theirs', itemTitle: '别人的商品', direction: 'inbound', bodyType: 'text', bodyText: '还在的，可以拍', occurredAt: '2026-10-21T10:00:00.000Z',
  });
  assert.equal(theirs.created, true);
  assert.deepEqual(autoReplyCalls, [], 'messages from the seller we are buying from are not answered');
  const theirsConversation = await store.findConversationByExternalRef(admin.id, account.id, 'conv-theirs');
  assert.equal(theirsConversation?.side, 'buyer');

  const mine = await service.handleExternalEvent(admin.id, {
    accountId: account.id, externalConversationRef: 'conv-mine', externalMessageRef: 'mine-1.PNM', senderRef: 'buyer-9', senderName: '买家',
    itemRef: 'item-mine', itemTitle: '我的商品', direction: 'inbound', bodyType: 'text', bodyText: '在吗', occurredAt: '2026-10-21T10:01:00.000Z',
  });
  assert.equal(mine.created, true);
  assert.deepEqual(autoReplyCalls, ['called'], 'buyers of our own listing still reach the auto-reply agent');
  const mineConversation = await store.findConversationByExternalRef(admin.id, account.id, 'conv-mine');
  assert.equal(mineConversation?.side, 'seller');

  // Deferred (inbox) path honours the same rule.
  await service.handleExternalEvent(admin.id, {
    accountId: account.id, externalConversationRef: 'conv-theirs', externalMessageRef: 'theirs-2.PNM', senderRef: 'other-seller',
    itemRef: 'item-theirs', direction: 'inbound', bodyType: 'text', bodyText: '要吗', occurredAt: '2026-10-21T10:02:00.000Z',
  }, { deferAutoReply: true });
  assert.deepEqual(autoReplyCalls, ['called']);
});

test('IM listener stays silent while the conversation side is unknown', async () => {
  const { store, admin, account } = await setup();
  const messages = new MessageService(store, async () => 'audit');
  const autoReplyCalls: string[] = [];
  const autoReply = { processInbound: async () => { autoReplyCalls.push('called'); return undefined; } };
  const service = new XianyuImService(store, {} as never, messages, autoReply as never);
  await service.handleExternalEvent(admin.id, {
    accountId: account.id, externalConversationRef: 'conv-unknown', externalMessageRef: 'u-1.PNM', senderRef: 'someone',
    direction: 'inbound', bodyType: 'text', bodyText: '你好', occurredAt: '2026-10-21T10:00:00.000Z',
  });
  assert.deepEqual(autoReplyCalls, []);
  const conversation = await store.findConversationByExternalRef(admin.id, account.id, 'conv-unknown');
  assert.equal(conversation?.side, 'unknown');
});
