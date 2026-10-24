import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OpenAICompatibleModelClient } from '../src/pi-runtime.js';
import { extractProductKeyword } from '../src/workspace-commands.js';

function completedPayload(text: string) {
  return { id: 'resp_1', status: 'completed', model: 'relay-model', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] };
}

describe('streamed tool-result rounds on a stalling relay', () => {
  it('falls back to a non-streamed request when no SSE event arrives, then skips streaming for later tool rounds', async () => {
    const calls: Array<{ stream: boolean }> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { stream?: boolean };
      calls.push({ stream: Boolean(body.stream) });
      if (body.stream) {
        // Headers arrive, but the body never produces a byte until aborted.
        const stream = new ReadableStream<Uint8Array>({ start(controller) { init.signal?.addEventListener('abort', () => controller.error(new Error('aborted'))); } });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify(completedPayload('查询结果：共 3 个商品')), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const client = new OpenAICompatibleModelClient({ apiKey: 'k', baseUrl: 'https://relay.example/v1', model: 'relay-model', wireApi: 'responses', timeoutMs: 12_000, fetchImpl });
    const messages = [
      { role: 'user' as const, content: '列出商品' },
      { role: 'assistant' as const, content: '', toolCalls: [{ id: 'call_1', type: 'function' as const, function: { name: 'product_search', arguments: '{}' } }] },
      { role: 'tool' as const, toolCallId: 'call_1', content: '{"items":[]}' },
    ];
    let text = '';
    const started = Date.now();
    const result = await client.stream({ messages }, { onTextDelta: (delta) => { text += delta; } });
    assert.equal(result.content, '查询结果：共 3 个商品');
    assert.equal(text, '查询结果：共 3 个商品');
    assert.deepEqual(calls.map((call) => call.stream), [true, false]);
    assert.ok(Date.now() - started < 9_000, 'stall detected well before the full timeout');

    calls.length = 0;
    await client.stream({ messages }, {});
    assert.deepEqual(calls.map((call) => call.stream), [false], 'later tool-result rounds skip streaming');
  });
});

describe('plain streamed rounds on a stalling relay', () => {
  it('stops streaming entirely after a plain round stalls', async () => {
    const calls: boolean[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { stream?: boolean };
      calls.push(Boolean(body.stream));
      if (body.stream) return new Response(new ReadableStream<Uint8Array>({ start(controller) { init.signal?.addEventListener('abort', () => controller.error(new Error('aborted'))); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      return new Response(JSON.stringify(completedPayload('好的')), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const client = new OpenAICompatibleModelClient({ apiKey: 'k', baseUrl: 'https://relay.example/v1', model: 'relay-model', wireApi: 'responses', timeoutMs: 12_000, fetchImpl });
    await client.stream({ messages: [{ role: 'user', content: '你好' }] }, {});
    await client.stream({ messages: [{ role: 'user', content: '再来' }] }, {});
    assert.deepEqual(calls, [true, false, false]);
  });
});

describe('extractProductKeyword', () => {
  it('ignores browse sentences and keeps real keywords', () => {
    assert.equal(extractProductKeyword('查询当前登录闲鱼账号的所有在售商品，列出每个商品的标题和价格。'), undefined);
    assert.equal(extractProductKeyword('列出我所有在售商品的标题和价格'), undefined);
    assert.equal(extractProductKeyword('查询 PPT 商品'), 'PPT');
    assert.equal(extractProductKeyword('搜索关键词：耳机'), '耳机');
    assert.equal(extractProductKeyword('查找「天卡」商品'), '天卡');
  });
});
