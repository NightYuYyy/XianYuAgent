import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QuickPhrasesEditor } from './QuickPhrasesEditor';

describe('quick phrases editor', () => {
  it('renders one row per phrase and an empty hint otherwise', () => {
    const html = renderToStaticMarkup(createElement(QuickPhrasesEditor, { phrases: [{ id: 'a', label: '发货说明', content: '拍下后自动发货' }, { id: 'b', label: '', content: '在的' }], onChange: () => undefined }));
    expect(html).toContain('发货说明');
    expect(html).toContain('拍下后自动发货');
    expect((html.match(/data-testid="quick-phrase"/g) ?? []).length).toBe(2);
    expect(renderToStaticMarkup(createElement(QuickPhrasesEditor, { phrases: [], onChange: () => undefined }))).toContain('还没有快捷短语');
  });
});
