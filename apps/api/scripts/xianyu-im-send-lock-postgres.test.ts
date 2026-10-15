import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresStore } from '../src/store-postgres.js';
import { XianyuImService } from '../src/xianyu-im-service.js';
import type { XianyuImClient } from '../src/xianyu-im.js';
import type { MessageService } from '../src/messages.js';
import type { XianyuMtopClient } from '../src/xianyu-mtop.js';

const databaseUrl = 'postgres://xianyu:xianyu_dev_only@127.0.0.1:5432/xianyu_agent';

function historyMessage(id: string, text: string, createdAt: number) {
  return { message: { messageId: id, senderUserId: 'seller@goofish', createAt: createdAt,
    content: { custom: { data: Buffer.from(JSON.stringify({ contentType: 1, text: { text } })).toString('base64') } } } };
}

test('two API instances serialize same-conversation sends and cannot claim one history message twice', async () => {
  const firstStore = new PostgresStore(databaseUrl);
  const secondStore = new PostgresStore(databaseUrl);
  const accountId = `account-${crypto.randomUUID()}`;
  const conversationId = 'local-conversation';
  const text = 'same-card-text';
  const history: unknown[] = [];
  let active = 0;
  let maxActive = 0;
  let sendCount = 0;
  let firstStarted!: () => void;
  const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
  const client = { selfUserIds: ['seller'],
    sendText: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const call = ++sendCount;
      if (call === 1) firstStarted();
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (call === 1) history.push(historyMessage('first.PNM', text, Date.now()));
      active -= 1;
      throw new Error('xianyu IM connection closed');
    },
    listMessages: async () => ({ userMessageModels: history }),
  } as unknown as XianyuImClient;
  const services = [firstStore, secondStore].map((store) => {
    store.getConversation = async () => ({ accountId, externalConversationRef: 'platform-conversation', buyerRef: 'buyer' }) as never;
    const service = new XianyuImService(store, {} as XianyuMtopClient, {} as MessageService);
    const internal = service as unknown as { ensureClient: () => Promise<XianyuImClient>; markAccountFailure: () => Promise<void>; clearImSendRisk: () => Promise<void> };
    internal.ensureClient = async () => client;
    internal.markAccountFailure = async () => undefined;
    internal.clearImSendRisk = async () => undefined;
    return service;
  });
  try {
    const firstSend = services[0]!.sendExternalText('admin', accountId, conversationId, text, 'request-0', 'trace');
    await firstStartedPromise;
    const secondSend = services[1]!.sendExternalText('admin', accountId, conversationId, text, 'request-1', 'trace');
    const [first, second] = await Promise.allSettled([firstSend, secondSend]);
    assert.equal(first.status, 'fulfilled');
    assert.deepEqual(first.status === 'fulfilled' ? first.value : undefined, { externalMessageRef: 'first.PNM' });
    assert.equal(second.status, 'rejected');
    assert.equal(second.status === 'rejected' ? (second.reason as { code?: string }).code : undefined, 'XIANYU_IM_SEND_OUTCOME_UNKNOWN');
    assert.equal(sendCount, 2);
    assert.equal(maxActive, 1);
  } finally {
    await Promise.all([firstStore.close(), secondStore.close()]);
  }
});
