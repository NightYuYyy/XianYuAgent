import { useCallback, useEffect, useState } from 'react';
import type { CouponsApi } from '../api';
import type { CouponBatchVM, CouponItemVM } from '../types';
import { InputField } from '../../../shared/ui/InputField';
import { TextAreaField } from '../../../shared/ui/TextAreaField';

const statusLabel: Record<CouponItemVM['status'], string> = { available: '可用', reserved: '预占中', consumed: '已用' };

function formatTime(value?: string) { return value ? value.replace('T', ' ').replace(/\.\d{3}Z$/, '').replace('Z', '') : ''; }
function describeUsage(item: CouponItemVM): string {
  if (item.status !== 'consumed') return item.status === 'reserved' ? '自动发货处理中' : '';
  const note = item.usageNote ?? '';
  const where = note.startsWith('order:') ? `订单 ${note.slice(6)}` : note === 'manual' ? '人工取用' : note || '已用';
  return `${where}${item.consumedAt ? ` · ${formatTime(item.consumedAt)}` : ''}`;
}
function splitCodes(raw: string): string[] { return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean); }

/**
 * 卡密明细：看每张的状态（可用 / 预占中 / 已用于哪个订单），手动取一张标记已用，单张改状态 / 改内容 / 删除，追加新卡密。
 * 明文直接展示（详情接口 includeContent，后端记一条审计），免得一张张点。
 */
export function CouponItemsModal({ batch, api, onClose }: { batch: CouponBatchVM; api: CouponsApi; onClose: () => void }) {
  const [detail, setDetail] = useState<CouponBatchVM | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [taken, setTaken] = useState<{ content: string; itemId: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

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

  async function run(label: string, action: () => Promise<void>) {
    setBusy(true); setError(null); setNotice(null);
    try { await action(); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : `${label}失败`); }
    finally { setBusy(false); }
  }
  async function copy(text: string, key: string) {
    try { await navigator.clipboard.writeText(text); setCopied(key); window.setTimeout(() => setCopied(null), 1500); } catch { setError('复制失败，请手动选中复制'); }
  }
  function take() {
    return run('取卡', async () => {
      const result = await api.takeItem(batch.batchId, 'manual');
      setTaken({ content: result.content, itemId: result.item.id });
      void copy(result.content, 'taken');
    });
  }
  function addCodes() {
    const codes = splitCodes(draft);
    if (codes.length === 0) { setError('先把要新增的卡密贴进来，一行一张'); return; }
    return run('新增', async () => {
      const result = await api.importItems(batch.batchId, codes);
      const rejected = result.rejected?.length ?? 0;
      const imported = result.importedCount ?? codes.length - rejected;
      setNotice(rejected > 0 ? `新增 ${imported} 张，跳过 ${rejected} 张（重复或为空）` : `新增 ${imported} 张`);
      setDraft(''); setAdding(false);
    });
  }
  function saveEdit() {
    if (!editing) return;
    const value = editing.value.trim();
    if (!value) { setError('卡密内容不能为空'); return; }
    return run('修改', async () => { await api.updateItem(batch.batchId, editing.id, value); setEditing(null); });
  }
  function remove(item: CouponItemVM) {
    if (confirmDelete !== item.id) { setConfirmDelete(item.id); window.setTimeout(() => setConfirmDelete((current) => (current === item.id ? null : current)), 4000); return; }
    setConfirmDelete(null);
    return run('删除', async () => { await api.deleteItem(batch.batchId, item.id); });
  }

  return <div className="coupons-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <section className="coupons-modal coupons-items-modal card" role="dialog" aria-modal="true" aria-label="卡密明细">
      <header><div><p className="eyebrow">Coupon Items</p><h2>卡密明细</h2><p>{batch.label}{detail?.metadata?.oneTime === false ? ' · 轮换复用（未开一次性）' : ''}</p></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭">×</button></header>
      <div className="coupons-items-summary"><span>共 <b>{counts.total}</b> 张</span><span>可用 <b>{counts.available}</b></span><span>已用 <b>{counts.consumed}</b></span>{counts.reserved > 0 && <span>预占中 <b>{counts.reserved}</b></span>}</div>
      <div className="coupons-items-take">
        <button className="btn primary btn-small" type="button" disabled={busy || counts.available === 0} onClick={() => void take()}>取一张并标记已用</button>
        <button className="btn ghost btn-small" type="button" disabled={busy} onClick={() => setAdding((value) => !value)}>{adding ? '收起新增' : '+ 新增卡密'}</button>
        <span className="coupons-form-hint">手动发货时用：取出的卡密会自动复制，发给买家即可。</span>
        {taken && <span className="coupons-items-taken" data-testid="coupon-taken-content">{taken.content}</span>}
        {taken && <button className="btn ghost btn-small" type="button" onClick={() => void copy(taken.content, 'taken')}>{copied === 'taken' ? '已复制' : '复制'}</button>}
      </div>
      {adding && <div className="coupons-items-add">
        <TextAreaField aria-label="新增卡密" rows={4} value={draft} disabled={busy} placeholder={'一行一张，例如：\nDT20261023ABCD1234\n卡号:密码'} onChange={(event) => setDraft(event.target.value)} />
        <div className="coupons-items-add-actions">
          <button className="btn primary btn-small" type="button" disabled={busy || splitCodes(draft).length === 0} onClick={() => void addCodes()}>添加 {splitCodes(draft).length || ''} 张</button>
          <button className="btn ghost btn-small" type="button" disabled={busy} onClick={() => { setDraft(''); setAdding(false); }}>取消</button>
          <span className="coupons-form-hint">和批次里已有的重复会自动跳过。</span>
        </div>
      </div>}
      {error && <p className="coupons-form-error" role="alert">{error}</p>}
      {notice && <p className="coupons-form-hint" role="status">{notice}</p>}
      <div className="coupons-items-list">
        <div className="coupons-item-row head"><span>#</span><span>卡密</span><span>状态</span><span className="coupons-item-note">用途 / 时间</span><span>操作</span></div>
        {!detail && !error && <div className="coupons-item-row"><span /><span>读取中…</span></div>}
        {items.map((item, index) => <div className="coupons-item-row" key={item.id}>
          <span className="coupons-muted">{index + 1}</span>
          {editing?.id === item.id
            ? <span className="coupons-item-edit"><InputField aria-label={`编辑卡密 ${index + 1}`} value={editing.value} autoFocus disabled={busy} onChange={(event) => setEditing({ id: item.id, value: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter') void saveEdit(); if (event.key === 'Escape') setEditing(null); }} /></span>
            : <span className="coupons-item-code" title={item.content ?? ''}>{item.content ?? '（无法读取）'}</span>}
          <span><span className={`coupons-item-badge ${item.status}`}>{statusLabel[item.status]}</span></span>
          <span className="coupons-item-note" title={describeUsage(item)}>{describeUsage(item) || '—'}</span>
          <span className="coupons-item-actions">
            {editing?.id === item.id
              ? <>
                <button className="btn primary btn-small" type="button" disabled={busy} onClick={() => void saveEdit()}>保存</button>
                <button className="btn ghost btn-small" type="button" disabled={busy} onClick={() => setEditing(null)}>取消</button>
              </>
              : <>
                <button className="btn ghost btn-small" type="button" disabled={!item.content} onClick={() => void copy(item.content ?? '', item.id)}>{copied === item.id ? '已复制' : '复制'}</button>
                {item.status === 'available' && <button className="btn ghost btn-small" type="button" disabled={busy} onClick={() => void run('标记', async () => { await api.setItemStatus(batch.batchId, item.id, 'consumed', 'manual'); })}>标记已用</button>}
                {item.status === 'consumed' && <button className="btn ghost btn-small" type="button" disabled={busy} onClick={() => void run('恢复', async () => { await api.setItemStatus(batch.batchId, item.id, 'available'); })}>恢复可用</button>}
                {item.status !== 'reserved' && <button className="btn ghost btn-small" type="button" disabled={busy} onClick={() => setEditing({ id: item.id, value: item.content ?? '' })}>编辑</button>}
                {item.status !== 'reserved' && <button className={`btn ghost btn-small${confirmDelete === item.id ? ' danger-text' : ''}`} type="button" disabled={busy} onClick={() => void remove(item)}>{confirmDelete === item.id ? '确认删除?' : '删除'}</button>}
              </>}
          </span>
        </div>)}
        {detail && items.length === 0 && <div className="coupons-item-row"><span /><span>这个批次还没有卡密，点上面「新增卡密」贴进来即可。</span></div>}
      </div>
      <footer><button className="btn ghost" type="button" onClick={onClose}>关闭</button></footer>
    </section>
  </div>;
}
