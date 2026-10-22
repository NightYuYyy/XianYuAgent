import { describe, expect, it } from 'vitest';
import { createMockSystemApi, createSystemApi } from './api';

describe('system api adapter', () => {
  it('reads the slider solver status from the system endpoint and unwraps the envelope', async () => {
    const paths: string[] = [];
    const api = createSystemApi({
      get: async <T>(path: string) => {
        paths.push(path);
        return { success: true, data: { configured: true, endpoint: 'http://172.17.0.1:18095/api/v1/captcha/slider-solve', fallback: 'local', timeoutMs: 120000, browserTimeoutSeconds: 60, localSliderMode: 'auto', probe: { reachable: false, latencyMs: 5001, error: 'TIMEOUT' }, checkedAt: '2026-10-22T10:00:00.000Z' } } as T;
      },
    });
    const status = await api.getSliderSolverStatus();
    expect(paths).toEqual(['/api/v1/system/slider-solver']);
    expect(status.configured).toBe(true);
    expect(status.probe?.error).toBe('TIMEOUT');
  });

  it('surfaces a failed envelope as an error', async () => {
    const api = createSystemApi({ get: async <T>() => ({ success: false, data: null, message: 'FORBIDDEN' } as T) });
    await expect(api.getSliderSolverStatus()).rejects.toThrow('FORBIDDEN');
  });

  it('mock adapter mirrors the production shape', async () => {
    const status = await createMockSystemApi().getSliderSolverStatus();
    expect(status.configured).toBe(true);
    expect(status.probe?.reachable).toBe(true);
    expect(status.probe?.stats?.real_mouse_available).toBe(true);
  });
});
