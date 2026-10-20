import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AccountTable } from './AccountTable';
import type { AccountVM } from '../types';

const account: AccountVM = {
  id: 'account-1',
  platform: 'xianyu',
  sellerRef: 'seller-1',
  displayName: '测试账号',
  status: 'pending',
  connection: { status: 'unknown' },
  enabled: true,
  aiEnabled: false,
  credentialState: 'missing',
  version: 1,
  updatedAt: new Date(0).toISOString(),
};

const accountWithAvatar: AccountVM = {
  ...account,
  avatarUrl: 'https://img.example.com/avatar.png',
};

describe('AccountTable', () => {
  it.each(['ACCOUNT_VALIDATION_REQUIRED', 'RGV587', 'UNRECOGNIZED_VENDOR_CODE'])('renders Chinese risk status without leaking %s or the backend source', (riskCode) => {
    const html = renderToStaticMarkup(createElement(AccountTable, {
      accounts: [{ ...account, status: 'verification_required', riskCode, riskSource: 'seller.orders.internal', riskFirstSeenAt: '2026-10-20T04:55:19.000Z' }],
      page: 1, total: 1, totalPages: 1,
      onPageChange: vi.fn(), onReauthorize: vi.fn(), onSwitch: vi.fn(), onDelete: vi.fn(),
    }));
    expect(html).toContain(riskCode === 'RGV587' ? '需滑块验证' : '需要安全验证');
    expect(html).not.toContain(riskCode);
    expect(html).not.toContain('seller.orders.internal');
  });

  it('restores the operation column and row actions', () => {
    const html = renderToStaticMarkup(createElement(AccountTable, {
      accounts: [account],
      activeAccountId: 'different-account',
      page: 1,
      total: 6,
      totalPages: 2,
      onPageChange: vi.fn(),
      onReauthorize: vi.fn(),
      onSwitch: vi.fn(),
      onDelete: vi.fn(),
    }));

    expect(html).toContain('<span role="columnheader">操作</span>');
    expect(html).toContain('data-testid="account-switch"');
    expect(html).toContain('切换账号');
    expect(html).toContain('扫码授权');
    expect(html).toContain('data-testid="account-delete"');
    expect(html).toContain('删除账号');
  });

  it('keeps the product-style three-part pagination summary', () => {
    const html = renderToStaticMarkup(createElement(AccountTable, {
      accounts: [account],
      page: 2,
      total: 6,
      totalPages: 2,
      onPageChange: vi.fn(),
      onReauthorize: vi.fn(),
      onSwitch: vi.fn(),
      onDelete: vi.fn(),
    }));

    expect(html).toContain('class="accounts-domain-pagination-total">共 6 个账号</span>');
    expect(html).toContain('data-testid="accounts-pagination"');
    expect(html).toContain('第 2 / 2 页');
    expect(html).toContain('accounts-domain-page-button active');
  });

  it('renders the account avatar when the API provides one', () => {
    const html = renderToStaticMarkup(createElement(AccountTable, {
      accounts: [accountWithAvatar],
      page: 1,
      total: 1,
      totalPages: 1,
      onPageChange: vi.fn(),
      onReauthorize: vi.fn(),
      onSwitch: vi.fn(),
      onDelete: vi.fn(),
    }));

    expect(html).toContain('src="https://img.example.com/avatar.png"');
    expect(html).toContain('class="accounts-domain-avatar"');
  });
});
