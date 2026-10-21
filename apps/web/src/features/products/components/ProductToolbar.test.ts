import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ProductToolbar } from './ProductToolbar';

describe('ProductToolbar', () => {
  it('does not render the redundant total-count item', () => {
    const html = renderToStaticMarkup(createElement(ProductToolbar, {
      contextLoading: false,
      contextError: null,
      contextMissing: false,
      filters: { page: 1, pageSize: 20, accountId: 'account-1', keyword: '商品', status: 'all' },
      phase: 'empty',
      syncing: false,
      onKeywordChange: vi.fn(),
      onStatusChange: vi.fn(),
      onRefresh: vi.fn(),
      onSync: vi.fn(),
      onCreate: vi.fn(),
      onChooseAccount: vi.fn(),
    }));

    expect(html).not.toContain('products-total');
    expect(html).not.toContain('共 0 件');
    expect(html).toContain('刷新');
    expect(html).not.toContain('刷新本地');
    expect(html).toContain('aria-label="清空搜索"');
  });

  it('renders the relist actions only when handlers are supplied and labels them by selection', () => {
    const base = {
      contextLoading: false, contextError: null, contextMissing: false,
      filters: { page: 1, pageSize: 20, accountId: 'account-1', keyword: '', status: 'all' as const },
      phase: 'success' as const, syncing: false, selectedCount: 2,
      onKeywordChange: vi.fn(), onStatusChange: vi.fn(), onRefresh: vi.fn(), onSync: vi.fn(), onCreate: vi.fn(), onChooseAccount: vi.fn(),
    };
    expect(renderToStaticMarkup(createElement(ProductToolbar, base))).not.toContain('batch-auto-relist');
    const html = renderToStaticMarkup(createElement(ProductToolbar, { ...base, autoRelistLabel: '关闭自动续售', onBatchAutoRelist: vi.fn(), onRelistNow: vi.fn() }));
    expect(html).toContain('关闭自动续售 2件');
    expect(html).toContain('立即续售 2件');
  });
});
