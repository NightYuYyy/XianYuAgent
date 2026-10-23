import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CouponItemsModal } from './CouponItemsModal';
import { createMockCouponsApi } from '../api';
import type { CouponBatchVM } from '../types';

describe('CouponItemsModal', () => {
  it('renders the summary, take action and the item table head', () => {
    const batch: CouponBatchVM = { batchId: '2', accountId: 'account-001', label: 'DT云端-测试卡', purpose: 'data', status: 'active', version: 1, updatedAt: '', bindings: [], items: [] };
    const html = renderToStaticMarkup(createElement(CouponItemsModal, { batch, api: createMockCouponsApi(), onClose: () => undefined }));
    expect(html).toContain('卡密明细');
    expect(html).toContain('DT云端-测试卡');
    expect(html).toContain('取一张并标记已用');
    expect(html).toContain('用途 / 时间');
    expect(html).toContain('新增卡密');
  });
});
