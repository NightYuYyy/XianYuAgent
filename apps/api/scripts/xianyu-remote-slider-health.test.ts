import assert from 'node:assert/strict';
import test from 'node:test';
import { XianyuRemoteSliderSolver } from '../src/xianyu-remote-slider.js';

const quietLogger = { info: () => undefined, warn: () => undefined };

function solverWith(fetchImpl: typeof fetch): XianyuRemoteSliderSolver {
  return new XianyuRemoteSliderSolver({ url: 'http://172.17.0.1:18095/api/v1/captcha/slider-solve', secret: 's3cret', logger: quietLogger, fetchImpl });
}

test('health probes /health on the solver origin and returns its stats', async () => {
  const seen: string[] = [];
  const solver = solverWith(async (input) => {
    seen.push(String(input));
    return new Response(JSON.stringify({ status: 'ok', real_mouse_available: true, platform: 'win32', requests: 3, success: 2, failed: 1, url_expired: 0, last_result_at: '2026-10-22 10:00:00' }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const health = await solver.health();
  assert.deepEqual(seen, ['http://172.17.0.1:18095/health']);
  assert.equal(health.reachable, true);
  assert.equal(health.httpStatus, 200);
  assert.equal(health.stats?.real_mouse_available, true);
  assert.equal(health.stats?.success, 2);
  assert.equal(solver.endpoint, 'http://172.17.0.1:18095/api/v1/captcha/slider-solve');
});

test('health reports an unreachable solver (tunnel down) without throwing', async () => {
  const solver = solverWith(async () => { throw new TypeError('fetch failed'); });
  const health = await solver.health();
  assert.equal(health.reachable, false);
  assert.equal(health.error, 'UNREACHABLE');
});

test('health treats non-2xx and non-JSON answers as unhealthy', async () => {
  const gateway = solverWith(async () => new Response('bad gateway', { status: 502 }));
  assert.deepEqual(await gateway.health().then((h) => [h.reachable, h.error]), [false, 'HTTP_502']);
  const html = solverWith(async () => new Response('<html>', { status: 200 }));
  assert.deepEqual(await html.health().then((h) => [h.reachable, h.error]), [false, 'INVALID_JSON']);
});

test('health times out instead of hanging on a half-open tunnel', async () => {
  const solver = solverWith((_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  const health = await solver.health(1_000);
  assert.equal(health.reachable, false);
  assert.equal(health.error, 'TIMEOUT');
});
