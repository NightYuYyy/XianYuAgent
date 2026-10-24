import { describe, expect, it } from 'vitest';
import { createMockProductsApi, draftImageEntries } from './api';

describe('draft continue-publish flow (mock api)', () => {
  it('keeps draft images, restores them, and archives the draft after publishing from it', async () => {
    const api = createMockProductsApi([]);
    const draft = await api.createDraft({ accountId: 'account-1', title: '草稿商品', description: '描述', priceMinor: 1500 });
    expect(draft.status).toBe('draft');
    const files = [new File([new Uint8Array(10)], 'a.png', { type: 'image/png' }), new File([new Uint8Array(20)], 'b.jpg', { type: 'image/jpeg' })];
    const saved = await api.saveDraftImages!(draft.id, files);
    expect(draftImageEntries(saved).map((entry) => entry.name)).toEqual(['a.png', 'b.jpg']);
    const restored = await api.loadDraftImages!(saved);
    expect(restored.map((file) => file.name)).toEqual(['a.png', 'b.jpg']);

    await api.publishProduct({ accountId: 'account-1', title: '草稿商品', description: '描述', priceMinor: 1500, postageMode: 'none', attachments: [], draftProductId: draft.id });
    const after = await api.list({ accountId: 'account-1' } as never);
    expect(after.items.find((item) => item.id === draft.id)?.status ?? 'archived').toBe('archived');
  });

  it('reads no entries from products without saved draft images', () => {
    expect(draftImageEntries(null)).toEqual([]);
    expect(draftImageEntries({ attributesJson: { publish: { images: [] } } } as never)).toEqual([]);
  });
});
