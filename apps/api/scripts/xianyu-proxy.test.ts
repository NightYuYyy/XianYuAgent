import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountProxyResolver, effectiveProxyUrl, normalizeProxyUrl, patchrightProxyFor, proxiedFetchFor, splitProxyUrl } from '../src/xianyu-proxy.js';

test('proxy URLs are validated and normalised', () => {
  assert.equal(normalizeProxyUrl('http://1.2.3.4:8080'), 'http://1.2.3.4:8080');
  assert.equal(normalizeProxyUrl('  http://1.2.3.4:8080/  '), 'http://1.2.3.4:8080');
  assert.equal(normalizeProxyUrl('http://user:p%40ss@proxy.example.com:3128'), 'http://user:p%40ss@proxy.example.com:3128');
  assert.equal(normalizeProxyUrl('https://proxy.example.com'), 'https://proxy.example.com');
  assert.equal(normalizeProxyUrl(''), undefined);
  assert.equal(normalizeProxyUrl(undefined), undefined);
  assert.equal(normalizeProxyUrl('socks5://1.2.3.4:1080'), undefined, 'only http(s) proxies are supported');
  assert.equal(normalizeProxyUrl('1.2.3.4:8080'), undefined);
  assert.equal(normalizeProxyUrl('http://1.2.3.4:8080/path'), undefined);
  assert.equal(normalizeProxyUrl('http://1.2.3.4:8080?x=1'), undefined);
});

test('credentials are split out for Patchright and the CONNECT tunnel', () => {
  assert.deepEqual(splitProxyUrl('http://user:p%40ss@proxy.example.com:3128'), { server: 'http://proxy.example.com:3128', username: 'user', password: 'p@ss' });
  assert.deepEqual(splitProxyUrl('http://proxy.example.com:3128'), { server: 'http://proxy.example.com:3128' });
  assert.deepEqual(patchrightProxyFor('http://u:p@h:1'), { server: 'http://h:1', username: 'u', password: 'p' });
  assert.equal(patchrightProxyFor(undefined), undefined);
  assert.equal(patchrightProxyFor('socks5://h:1'), undefined);
});

test('account proxy falls back to the environment default and then to direct', () => {
  assert.equal(effectiveProxyUrl({ proxyUrl: 'http://a:1' }, { XIANYU_DEFAULT_PROXY_URL: 'http://d:1' }), 'http://a:1');
  assert.equal(effectiveProxyUrl({ proxyUrl: '' }, { XIANYU_DEFAULT_PROXY_URL: 'http://d:1' }), 'http://d:1');
  assert.equal(effectiveProxyUrl(undefined, { XIANYU_DEFAULT_PROXY_URL: 'not a url' }), undefined);
  assert.equal(effectiveProxyUrl(undefined, {}), undefined);
  assert.equal(proxiedFetchFor(undefined), globalThis.fetch);
  assert.notEqual(proxiedFetchFor('http://127.0.0.1:1'), globalThis.fetch);
});

test('resolver caches lookups per account and survives store failures', async () => {
  let loads = 0;
  let clock = 1_000;
  const resolver = new AccountProxyResolver(async (_adminId, accountId) => {
    loads += 1;
    if (accountId === 'boom') throw new Error('db down');
    return { proxyUrl: accountId === 'with' ? 'http://acc:1' : undefined };
  }, 1_000, { XIANYU_DEFAULT_PROXY_URL: 'http://default:1' }, () => clock);
  assert.equal(await resolver.resolve('admin', 'with'), 'http://acc:1');
  assert.equal(await resolver.resolve('admin', 'with'), 'http://acc:1');
  assert.equal(loads, 1, 'second lookup inside the ttl is served from cache');
  clock += 1_001;
  assert.equal(await resolver.resolve('admin', 'with'), 'http://acc:1');
  assert.equal(loads, 2);
  assert.equal(await resolver.resolve('admin', 'without'), 'http://default:1');
  assert.equal(await resolver.resolve('admin', 'boom'), 'http://default:1', 'a store error degrades to the default proxy');
  resolver.invalidate('with');
  await resolver.resolve('admin', 'with');
  assert.equal(loads, 5);
});
