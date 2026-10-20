import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Toast } from './Toast';

describe('Toast', () => {
  it('renders accessible retry actions and prevents duplicate submissions while busy', () => {
    const html = renderToStaticMarkup(createElement(Toast, { message: '需要安全验证', actions: [{ label: '确认中…', disabled: true, onClick: vi.fn() }] }));
    expect(html).toContain('class="app-toast-actions"');
    expect(html).toContain('type="button" disabled="">确认中…</button>');
    expect(html).toContain('role="status"');
  });

  it('renders an accessible error alert with a dismiss action', () => {
    const html = renderToStaticMarkup(createElement(Toast, { message: '同步失败', tone: 'error', onDismiss: vi.fn() }));
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain('同步失败');
    expect(html).toContain('aria-label="关闭提示"');
  });
});
