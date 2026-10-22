import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { XianyuEditModal } from './XianyuEditModal';

describe('XianyuEditModal', () => {
  it('renders nothing while idle and a form with skus and images when ready', () => {
    const idle = renderToStaticMarkup(createElement(XianyuEditModal, { state: { phase: 'idle', detail: null, error: null }, onClose: vi.fn(), onSubmit: vi.fn() }));
    expect(idle).toBe('');
    const html = renderToStaticMarkup(createElement(XianyuEditModal, {
      state: {
        phase: 'ready', productId: 'p1', error: null,
        detail: { itemId: '1094254313008', title: '旧标题', description: '旧描述', multiSpec: true, quantity: 297, images: [{ url: 'https://img/a.png', width: 800, height: 800 }], skus: [{ value: '10页以内', priceMinor: 1990, quantity: 99 }] },
      },
      onClose: vi.fn(), onSubmit: vi.fn(),
    }));
    expect(html).toContain('编辑闲鱼商品');
    expect(html).toContain('1094254313008');
    expect(html).toContain('10页以内');
    expect(html).toContain('https://img/a.png');
    expect(html).toContain('保存到闲鱼');
    expect(html).toContain('主图');
  });

  it('shows the loading state before the snapshot arrives', () => {
    const html = renderToStaticMarkup(createElement(XianyuEditModal, { state: { phase: 'loading', productId: 'p1', detail: null, error: null }, onClose: vi.fn(), onSubmit: vi.fn() }));
    expect(html).toContain('正在从闲鱼读取当前商品');
  });
});
