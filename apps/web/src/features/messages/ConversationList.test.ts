import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConversationList, ConversationListState, conversationDisplayName, conversationInitial } from './components/ConversationList';
import type { ConversationVM } from './types';

describe('conversation identity fallbacks', () => {
  it('trims a loaded nickname before rendering it', () => {
    expect(conversationDisplayName({ buyerDisplayName: '  买家昵称  ', buyerRef: 'buyer-1' })).toBe('买家昵称');
  });

  it('falls back to the buyer reference when nickname is missing', () => {
    expect(conversationDisplayName({ buyerDisplayName: '  ', buyerRef: 'buyer-42' })).toBe('buyer-42');
    expect(conversationInitial({ buyerDisplayName: undefined, buyerRef: 'buyer-42' })).toBe('B');
  });

  it('uses an explicit placeholder when both identity fields are absent', () => {
    expect(conversationDisplayName({ buyerDisplayName: undefined, buyerRef: '' })).toBe('未知买家');
    expect(conversationInitial({ buyerDisplayName: undefined, buyerRef: '' })).toBe('未');
  });

  it('renders sidebar empty states with the shared centered state class', () => {
    const html = renderToStaticMarkup(createElement(ConversationListState, {
      children: createElement('span', null, '试试用户昵称、商品标题或最后一条消息。'),
    }));

    expect(html).toContain('class="messages-state messages-sidebar-state"');
    expect(html).toContain('试试用户昵称、商品标题或最后一条消息。');
  });
});

describe('conversation handling badges', () => {
  const base: ConversationVM = { conversationId: 'c-1', accountId: 'a-1', buyerRef: 'buyer-1', buyerDisplayName: '小明', unreadCount: 0, handlingMode: 'ai', side: 'seller', version: 1, createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z' };
  const render = (conversation: ConversationVM) => renderToStaticMarkup(createElement(ConversationList, { conversations: [conversation], onSelect: () => undefined }));

  it('marks conversations the operator took over', () => {
    expect(render({ ...base, handlingMode: 'human' })).toContain('人工');
    expect(render(base)).not.toContain('messages-conversation-mode');
  });

  it('does not stack the takeover badge on buyer-side conversations where AI never replies anyway', () => {
    const html = render({ ...base, handlingMode: 'human', side: 'buyer' });
    expect(html).toContain('我在买');
    expect(html).not.toContain('messages-conversation-mode');
  });
});
