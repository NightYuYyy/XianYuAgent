import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { sanitizeQuickPhrases, validateQuickPhrases } from '../src/chat-quick-phrases.js';

test('quick phrase sanitizer tolerates junk and validator explains mistakes', () => {
  const sanitized = sanitizeQuickPhrases([{ content: '  在的，拍下自动发货  ' }, { label: ' 发货 ', content: '已发货，请查收' }, { content: '' }, 'junk', { label: 'x' }]);
  assert.deepEqual(sanitized.map((item) => [item.id, item.label, item.content]), [['qp-1', '在的，拍下自动发货', '在的，拍下自动发货'], ['qp-2', '发货', '已发货，请查收']]);
  assert.deepEqual(sanitizeQuickPhrases(undefined), []);
  assert.deepEqual(validateQuickPhrases(undefined), []);
  assert.throws(() => validateQuickPhrases([{ content: '' }]), /内容不能为空/);
  assert.throws(() => validateQuickPhrases([{ content: 'x', label: '这个名称实在是太长了超过了二十个字的限制啊啊' }]), /名称超过/);
  assert.throws(() => validateQuickPhrases('nope'), /must be an array/);
  const validated = validateQuickPhrases([{ id: 'a', content: '你好' }, { id: 'a', content: '再见' }]);
  assert.notEqual(validated[0]?.id, validated[1]?.id, 'duplicate ids are made unique');
});

test('quick phrases round-trip through the agent settings store', async () => {
  const runtime = createApp(loadConfig({
    HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '', REDIS_URL: '', ALLOW_IN_MEMORY: 'true', COOKIE_SECURE: 'false', XIANYU_QR_MODE: 'stub', AGENT_RUNTIME: 'in-process',
    API_KEY: 'test-key', AUTO_REPLY_MODEL_ENABLED: 'false', AUTO_REPLY_SEND_MODE: 'simulate',
  }));
  await runtime.listen();
  try {
    const boot = await runtime.auth.bootstrap({ email: 'quick-phrases@example.com', password: 'password-123', displayName: 'Quick Phrases' });
    const account = await runtime.store.createAccount({ adminId: boot.admin.id, platform: 'xianyu', sellerRef: 'quick-phrases-seller' });
    const before = await runtime.autoReplyAgentSettings.get(boot.admin.id, account.id);
    const saved = await runtime.autoReplyAgentSettings.update({ adminId: boot.admin.id, accountId: account.id, expectedVersion: before.configVersion, patch: { quickPhrases: [{ id: 'hello', label: '问好', content: '您好，在的～' }] }, requestId: 'qp-1', traceId: 'qp-1' });
    assert.deepEqual(saved.quickPhrases, [{ id: 'hello', label: '问好', content: '您好，在的～' }]);
    const reloaded = await runtime.autoReplyAgentSettings.get(boot.admin.id, account.id);
    assert.deepEqual(reloaded.quickPhrases, saved.quickPhrases);
    assert.equal(reloaded.enabled, before.enabled, 'other fields are untouched');
    await assert.rejects(runtime.autoReplyAgentSettings.update({ adminId: boot.admin.id, accountId: account.id, expectedVersion: reloaded.configVersion, patch: { quickPhrases: [{ content: '' }] }, requestId: 'qp-2', traceId: 'qp-2' }), /内容不能为空/);
  } finally {
    await runtime.close();
  }
});
