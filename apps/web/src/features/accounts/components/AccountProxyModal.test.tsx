import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountProxyModal, isValidProxyUrl } from './AccountProxyModal';
import type { AccountVM } from '../types';

const account: AccountVM = {
  id: 'acc-1',
  platform: 'xianyu',
  sellerRef: '3477613846',
  displayName: '陈陈cc',
  status: 'connected',
  connection: { status: 'online' },
  enabled: true,
  aiEnabled: true,
  credentialState: 'configured',
  version: 1,
  updatedAt: '2026-10-21T00:00:00.000Z',
  proxyUrl: 'http://user:pass@1.2.3.4:3128',
};

describe('AccountProxyModal', () => {
  it('validates http(s) proxy urls only', () => {
    expect(isValidProxyUrl('http://1.2.3.4:3128')).toBe(true);
    expect(isValidProxyUrl('https://user:p@proxy.example.com')).toBe(true);
    expect(isValidProxyUrl('socks5://1.2.3.4:1080')).toBe(false);
    expect(isValidProxyUrl('1.2.3.4:3128')).toBe(false);
    expect(isValidProxyUrl('http://1.2.3.4:3128/path')).toBe(false);
  });

  it('renders the current proxy, a clear action and the account name', () => {
    const html = renderToStaticMarkup(<AccountProxyModal account={account} onClose={vi.fn()} onSave={vi.fn()} />);
    expect(html).toContain('账号出站代理');
    expect(html).toContain('陈陈cc');
    expect(html).toContain('http://user:pass@1.2.3.4:3128');
    expect(html).toContain('清除代理');
  });

  it('hides the clear action when no proxy is set', () => {
    const html = renderToStaticMarkup(<AccountProxyModal account={{ ...account, proxyUrl: undefined }} onClose={vi.fn()} onSave={vi.fn()} />);
    expect(html).not.toContain('清除代理');
  });
});
