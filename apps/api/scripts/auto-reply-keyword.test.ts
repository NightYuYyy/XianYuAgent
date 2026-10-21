import assert from 'node:assert/strict';
import test from 'node:test';
import type { AutoReplyGenerator } from '../src/auto-reply.js';
import { KeywordFirstAutoReplyGenerator, matchKeywordRule, sanitizeKeywordRules, validateKeywordRules, type AutoReplyKeywordRule } from '../src/auto-reply-keyword.js';

const quiet = { info: () => undefined, warn: () => undefined };

const rules: AutoReplyKeywordRule[] = [
  { id: 'ship', keywords: ['发货了吗', '什么时候发货'], reply: '拍下后系统自动发货，请查看聊天记录里的卡密。', matchMode: 'contains', enabled: true },
  { id: 'exact-hi', keywords: ['在吗', '在不在'], reply: '在的，直接拍就行。', matchMode: 'exact', enabled: true },
  { id: 'discount', keywords: ['便宜|优惠|降价'], reply: '已经是最低价啦。', matchMode: 'regex', enabled: true },
  { id: 'ppt-only', keywords: ['怎么用'], reply: 'PPT Master 的使用教程见卡密里的链接。', matchMode: 'contains', productRef: 'item-ppt', enabled: true },
  { id: 'off', keywords: ['退款'], reply: '不会被发出的回复', matchMode: 'contains', enabled: false },
];

test('keyword matching: contains / exact / regex / product scope / disabled / order', () => {
  assert.equal(matchKeywordRule(rules, '老板 发货了吗？')?.id, 'ship');
  assert.equal(matchKeywordRule(rules, '  在吗 ')?.id, 'exact-hi');
  assert.equal(matchKeywordRule(rules, '在吗在吗在吗'), undefined, 'exact mode requires the whole message to equal the keyword');
  assert.equal(matchKeywordRule(rules, '能不能优惠一点')?.id, 'discount');
  assert.equal(matchKeywordRule(rules, '这个怎么用', 'item-ppt')?.id, 'ppt-only');
  assert.equal(matchKeywordRule(rules, '这个怎么用', 'item-other'), undefined, 'product-scoped rules do not fire for other items');
  assert.equal(matchKeywordRule(rules, '这个怎么用'), undefined);
  assert.equal(matchKeywordRule(rules, '我要退款'), undefined, 'disabled rules never fire');
  assert.equal(matchKeywordRule(rules, '   '), undefined);
  assert.equal(matchKeywordRule(rules, '发货了吗 能便宜点吗')?.id, 'ship', 'first rule in list order wins');
});

test('rules are validated strictly on write and sanitised leniently on read', () => {
  const valid = validateKeywordRules([
    { keywords: ' 发货 ,发货了吗，\n什么时候发 ', reply: '  已自动发货  ' },
    { id: 'r2', keywords: ['在吗'], reply: '在', matchMode: 'exact', enabled: false, productRef: ' item-1 ' },
  ]);
  assert.deepEqual(valid, [
    { id: 'kw-1', keywords: ['发货', '发货了吗', '什么时候发'], reply: '已自动发货', matchMode: 'contains', enabled: true },
    { id: 'r2', keywords: ['在吗'], reply: '在', matchMode: 'exact', productRef: 'item-1', enabled: false },
  ]);
  assert.deepEqual(validateKeywordRules(undefined), []);
  assert.throws(() => validateKeywordRules({}), /must be an array/);
  assert.throws(() => validateKeywordRules([{ keywords: [], reply: 'x' }]), /at least one keyword/);
  assert.throws(() => validateKeywordRules([{ keywords: ['a'], reply: '   ' }]), /reply must be/);
  assert.throws(() => validateKeywordRules([{ keywords: ['a'], reply: 'x', matchMode: 'fuzzy' }]), /matchMode/);
  assert.throws(() => validateKeywordRules([{ keywords: ['('], reply: 'x', matchMode: 'regex' }]), /invalid regular expression/);
  const duplicateIds = validateKeywordRules([{ id: 'same', keywords: ['a'], reply: 'x' }, { id: 'same', keywords: ['b'], reply: 'y' }]);
  assert.notEqual(duplicateIds[0]?.id, duplicateIds[1]?.id);

  const lenient = sanitizeKeywordRules([
    { keywords: ['ok'], reply: 'fine' },
    { keywords: [], reply: 'dropped' },
    { keywords: ['('], reply: 'dropped regex', matchMode: 'regex' },
    'garbage',
    { keywords: 'a,b', reply: 'string keywords', matchMode: 'nope', enabled: false },
  ]);
  assert.deepEqual(lenient.map((rule) => [rule.id, rule.keywords, rule.matchMode, rule.enabled]), [['kw-1', ['ok'], 'contains', true], ['kw-5', ['a', 'b'], 'contains', false]]);
  assert.deepEqual(sanitizeKeywordRules('not a list'), []);
});

test('keyword-first generator answers matches itself, delegates the rest and caches rule loads', async () => {
  let loads = 0;
  let innerCalls = 0;
  const inner: AutoReplyGenerator = {
    supportsStructuredDecision: true,
    supportsMultimodal: true,
    async generate() { innerCalls += 1; return { text: '模型回复', decision: 'reply' }; },
    async segmentReply({ reply }) { return [reply]; },
  };
  let clock = 1_000;
  const generator = new KeywordFirstAutoReplyGenerator(async () => { loads += 1; return rules; }, inner, { cacheMs: 1_000, now: () => clock, logger: quiet });
  assert.equal(generator.supportsStructuredDecision, true);
  assert.equal(generator.supportsMultimodal, true);
  const context = (text: string, overrides: Record<string, unknown> = {}) => ({
    conversation: { id: 'conv-1', accountId: 'acc-1', itemRef: 'item-ppt' },
    inboundMessage: { bodyType: 'text', bodyText: text },
    recentMessages: [],
    orders: [],
    ...overrides,
  }) as unknown as Parameters<AutoReplyGenerator['generate']>[0]['context'];
  const classification = { intent: 'other', confidence: 1, decision: 'replied', riskFlags: [] } as unknown as Parameters<AutoReplyGenerator['generate']>[0]['classification'];

  const hit = await generator.generate({ adminId: 'admin', context: context('请问发货了吗'), classification });
  assert.deepEqual(hit, { text: '拍下后系统自动发货，请查看聊天记录里的卡密。', decision: 'reply', reason: 'keyword:ship' });
  assert.equal(innerCalls, 0);

  const scoped = await generator.generate({ adminId: 'admin', context: context('这个怎么用'), classification });
  assert.equal((scoped as { reason?: string }).reason, 'keyword:ppt-only', 'conversation itemRef scopes product rules');

  const pending = await generator.generate({ adminId: 'admin', context: context('随便', { pendingBuyerMessages: [{ bodyText: '你好' }, { bodyText: '什么时候发货呀' }] }), classification });
  assert.equal((pending as { reason?: string }).reason, 'keyword:ship', 'the whole pending batch is scanned');

  const miss = await generator.generate({ adminId: 'admin', context: context('这个和那个有什么区别'), classification });
  assert.deepEqual(miss, { text: '模型回复', decision: 'reply' });
  assert.equal(innerCalls, 1);

  const image = await generator.generate({ adminId: 'admin', context: context('发货了吗', { inboundMessage: { bodyType: 'image', bodyText: '发货了吗' } }), classification });
  assert.deepEqual(image, { text: '模型回复', decision: 'reply' }, 'image messages always go to the model');

  assert.equal(loads, 1, 'rules are cached across generations');
  clock += 1_001;
  await generator.generate({ adminId: 'admin', context: context('x'), classification });
  assert.equal(loads, 2);
  generator.invalidate('acc-1');
  await generator.generate({ adminId: 'admin', context: context('x'), classification });
  assert.equal(loads, 3);

  const noInner = new KeywordFirstAutoReplyGenerator(async () => rules, undefined, { logger: quiet });
  assert.equal(await noInner.generate({ adminId: 'admin', context: context('完全无关'), classification }), undefined);
  assert.equal(noInner.supportsStructuredDecision, undefined);
  assert.deepEqual(await generator.segmentReply({ reply: 'a' }), ['a']);

  const failingLoader = new KeywordFirstAutoReplyGenerator(async () => { throw new Error('db down'); }, inner, { logger: quiet });
  assert.deepEqual(await failingLoader.generate({ adminId: 'admin', context: context('发货了吗'), classification }), { text: '模型回复', decision: 'reply' }, 'a failing rule load degrades to the model');
});
