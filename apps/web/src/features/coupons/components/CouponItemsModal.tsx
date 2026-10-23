import { useCallback, useEffect, useState } from 'react';
import type { CouponsApi } from '../api';
import type { CouponBatchVM, CouponItemVM } from '../types';

const statusLabel: Record<CouponItemVM['status'], string> = { available: '可用', reserved: '预占中', consumed: '已用' };

function formatTime(value?: string) { return value ? value.replace('T', ' ').replace(/\.\d{3}Z$/, '').replace('Z', '') : ''; }
function describeUsage(item: CouponItemVM): string {
  if (item.status !== 'consumed') return item.status === 'reserved' ? '自动发货处理中' : '';
  const note = item.usageNote ?? '';
  const where = note.startsWith('order:') ? `订单 ${note.slice(6)}` : note === 'manual' ? '人工取用' : note || '已用';
  return `${where}${item.consumedAt ? ` · ${formatTime(item.consumedAt)}` : ''}`;
}

/**
 * 卡密明细：看每张的状态（可用 / 预占中 / 已用于哪个订单），手动取一张标记已用，或单张改状态。
 * 明文直接展示（详情接口 includeContent，后端记一条审计），免得一张张点。
 */
export function CouponItemsModal({ batch, api, onClose }: { batch: CouponBatchVM; api: CouponsApi; onClose: () => void }) {
  const [detail, setDetail] = useState<CouponBatchVM | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [taken, setTaken] = useState<{ content: string; itemId: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setDetail(await api.getDetail(batch.batchId, { includeContent: true })); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : '读取失败'); }
  }, [api, batch.batchId]);
  useEffect(() => { void load(); }, [load]);

  const items = detail?.items ?? [];
  const counts = {
    total: items.length,
    available: items.filter((item) => item.status === 'available').length,
    reserved: items.filter((item) => item.status === 'reserved').length,
    consumed: items.filter((item) => item.status === 'consumed').length,
  };

  async function copy(text: string, key: string) {
    try { await navigator.clipboard.writeText(text); setCopied(key); window.setTimeout(() => setCopied(null), 1500); } catch { setError('复制失败，请手动选中复制'); }
  }
  async function take() {
    setBusy(true);
    try {
      const result = await api.takeItem(batch.batchId, 'manual');
      setTaken({ content: result.content, itemId: result.item.id });
      await load();
      void copy(result.content, 'taken');
    } catch (err) { setError(err instanceof Error ? err.message : '取卡失败'); }
    finally { setBusy(false); }
  }
  async function setStatus(item: CouponItemVM, status: 'available' | 'consumed') {
    setBusy(true);
    try { await api.setItemStatus(batch.batchId, item.id, status, 'manual'); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : '修改失败'); }
    finally { setBusy(false); }
  }

  return <div className="coupons-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <section className="coupons-modal coupons-items-modal card" role="dialog" aria-modal="true" aria-label="卡密明细">
      <header><div><p className="eyebrow">Coupon Items</p><h2>卡密明细</h2><p>{batch.label}{detail?.metadata?.oneTime === false ? ' · 轮换复用（未开一次性）' : ''}</p></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭">×</button></header>
      <div className="coupons-items-summary"><span>共 <b>{counts.total}</b> 张</span><span>可用 <b>{counts.available}</b></span><span>已用 <b>{counts.consumed}</b></span>{counts.reserved > 0 && <span>预占中 <b>{counts.reserved}</b></span>}</div>
      <div className="coupons-items-take">
        <button className="btn primary btn-small" type="button" disabled={busy || counts.available === 0} onClick={() => void take()}>取一张并标记已用</button>
        <span className="coupons-form-hint">手动发货时用：取出的卡密会自动复制，发给买家即可。</span>
        {taken && <span className="coupons-items-taken" data-testid="coupon-taken-content">{taken.content}</span>}
        {taken && <button className="btn ghost btn-small" type="button" onClick={() => void copy(taken.content, 'taken')}>{copied === 'taken' ? '已复制' : '复制'}</button>}
      </div>
      {error && <p className="coupons-form-error" role="alert">{error}</p>}
      <div className="coupons-items-list">
        <div className="coupons-item-row head"><span>#</span><span>卡密</span><span>状态</span><span className="coupons-item-note">用途 / 时间</span><span>操作</span></div>
        {!detail && !error && <div className="coupons-item-row"><span /><span>读取中…</span></div>}
        {items.map((item, index) => <div className="coupons-item-row" key={item.id}>
          <span className="coupons-muted">{index + 1}</span>
          <span className="coupons-item-code" title={item.content ?? ''}>{item.content ?? '（无法读取）'}</span>
          <span><span className={`coupons-item-badge ${item.status}`}>{statusLabel[item.status]}</span></span>
          <span className="coupons-item-note" title={describeUsage(item)}>{describeUsage(item) || '—'}</span>
          <span className="coupons-item-actions">
            <button className="btn ghost btn-small" type="button" disabled={!item.content} onClick={() => void copy(item.content ?? '', item.id)}>{copied === item.id ? '已复制' : '复制'}</button>
            {item.status === 'available' && <button className="btn ghost btn-small" type="button" disabled={busy} onClick={() => void setStatus(item, 'consumed')}>标记已用</button>}
            {item.status === 'consumed' && <button className="btn ghost btn-small" type="button" disabled={busy} onClick={() => void setStatus(item, 'available')}>恢复可用</button>}
          </span>
        </div>)}
        {detail && items.length === 0 && <div className="coupons-item-row"><span /><span>这个批次还没有卡密，编辑批次把卡密贴进「数据内容」即可。</span></div>}
      </div>
      <footer><button className="btn ghost" type="button" onClick={onClose}>关闭</button></footer>
    </section>
  </div>;
}
