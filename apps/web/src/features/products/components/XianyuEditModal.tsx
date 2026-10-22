import { useEffect, useState } from 'react';
import type { XianyuEditDetailVM, XianyuEditRequest, XianyuEditState } from '../types';
import { InputField } from '../../../shared/ui/InputField';
import { TextAreaField } from '../../../shared/ui/TextAreaField';

const MAX_IMAGES = 9;
const MONEY = /^\d+(?:\.\d{1,2})?$/;
const yuan = (minor?: number) => (minor === undefined ? '' : (minor / 100).toFixed(2));
const toMinor = (value: string) => Math.round(Number(value) * 100);

/**
 * 编辑已发布到闲鱼的商品：标题、描述、价格/库存（单规格或每个规格）、图片（保留/删除/新增）。
 * 提交走 POST /api/v1/products/:id/xianyu-edit，后端拿平台快照全量回传，没改的字段不会丢。
 */
export function XianyuEditModal({ state, onClose, onSubmit }: {
  state: XianyuEditState;
  onClose: () => void;
  onSubmit: (input: XianyuEditRequest) => Promise<boolean>;
}) {
  const detail = state.detail;
  // 首次渲染直接按快照初始化（服务端渲染没有 effect），之后快照变化再由 effect 重置
  const [title, setTitle] = useState(detail?.title ?? '');
  const [description, setDescription] = useState(detail?.description ?? '');
  const [priceYuan, setPriceYuan] = useState(yuan(detail?.priceMinor));
  const [quantity, setQuantity] = useState(String(detail?.quantity ?? ''));
  const [skus, setSkus] = useState<Array<{ value: string; priceYuan: string; quantity: string }>>((detail?.skus ?? []).map((sku) => ({ value: sku.value, priceYuan: yuan(sku.priceMinor), quantity: String(sku.quantity) })));
  const [keep, setKeep] = useState<string[]>((detail?.images ?? []).map((image) => image.url));
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!detail) return;
    setTitle(detail.title);
    setDescription(detail.description);
    setPriceYuan(yuan(detail.priceMinor));
    setQuantity(String(detail.quantity));
    setSkus(detail.skus.map((sku) => ({ value: sku.value, priceYuan: yuan(sku.priceMinor), quantity: String(sku.quantity) })));
    setKeep(detail.images.map((image) => image.url));
    setFiles([]);
    setPreviews([]);
    setLocalError(null);
  }, [detail]);

  useEffect(() => () => { previews.forEach((url) => URL.revokeObjectURL(url)); }, [previews]);

  if (state.phase === 'idle') return null;

  function addFiles(list: FileList | null) {
    if (!list) return;
    const next = [...files];
    const nextPreviews = [...previews];
    for (const file of Array.from(list)) {
      if (!file.type.startsWith('image/')) continue;
      if (keep.length + next.length >= MAX_IMAGES) break;
      next.push(file);
      nextPreviews.push(URL.createObjectURL(file));
    }
    setFiles(next);
    setPreviews(nextPreviews);
  }

  function buildRequest(detailVM: XianyuEditDetailVM): XianyuEditRequest | string {
    const input: XianyuEditRequest = {};
    if (!title.trim()) return '标题不能为空。';
    if (!description.trim()) return '描述不能为空。';
    if (title.trim() !== detailVM.title) input.title = title.trim();
    if (description.trim() !== detailVM.description) input.description = description.trim();
    if (detailVM.multiSpec) {
      const changedSkus = [];
      for (const [index, sku] of skus.entries()) {
        const original = detailVM.skus[index];
        if (!MONEY.test(sku.priceYuan) || Number(sku.priceYuan) <= 0) return `规格「${sku.value}」的售价要大于 0。`;
        if (!/^\d+$/.test(sku.quantity)) return `规格「${sku.value}」的库存要是整数。`;
        const priceMinor = toMinor(sku.priceYuan);
        const qty = Number(sku.quantity);
        if (original && (priceMinor !== original.priceMinor || qty !== original.quantity)) changedSkus.push({ value: sku.value, priceMinor, quantity: qty });
      }
      if (changedSkus.length) input.skus = changedSkus;
    } else {
      if (!MONEY.test(priceYuan) || Number(priceYuan) <= 0) return '售价要大于 0。';
      if (!/^\d+$/.test(quantity)) return '库存要是整数。';
      if (toMinor(priceYuan) !== detailVM.priceMinor) input.priceMinor = toMinor(priceYuan);
      if (Number(quantity) !== detailVM.quantity) input.quantity = Number(quantity);
    }
    const originalUrls = detailVM.images.map((image) => image.url);
    if (files.length > 0 || keep.join('\n') !== originalUrls.join('\n')) {
      if (keep.length + files.length < 1) return '至少要有 1 张图片。';
      input.keepImageUrls = keep;
      if (files.length) input.newImages = files;
    }
    if (Object.keys(input).length === 0) return '没有改动。';
    return input;
  }

  async function submit() {
    if (!detail) return;
    const request = buildRequest(detail);
    if (typeof request === 'string') { setLocalError(request); return; }
    setLocalError(null);
    const ok = await onSubmit(request);
    if (ok) onClose();
  }

  const saving = state.phase === 'saving';
  return <div className="products-detail-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <aside className="products-detail-panel xianyu-edit-panel" role="dialog" aria-modal="true" aria-label="编辑闲鱼商品">
      <header>
        <div>
          <p className="eyebrow">Edit on Xianyu</p>
          <h2>编辑闲鱼商品</h2>
          {detail && <p className="xianyu-detail-subtitle">闲鱼商品 ID：{detail.itemId} · 改完直接生效，没改的字段原样保留</p>}
        </div>
        <div className="products-detail-header-actions"><button className="btn ghost" type="button" onClick={onClose} disabled={saving}>关闭</button></div>
      </header>
      <div className="products-detail-body xianyu-edit-body">
        {state.phase === 'loading' && <p className="xianyu-detail-empty">正在从闲鱼读取当前商品…</p>}
        {state.phase === 'error' && !detail && <div className="products-inline-error" role="alert">{state.error ?? '读取失败'}</div>}
        {detail && <>
          <label className="xianyu-edit-field"><span>标题</span><InputField aria-label="商品标题" value={title} maxLength={60} disabled={saving} onChange={(event) => setTitle(event.target.value)} /><small>闲鱼标题大约 30 字以内，超长会被拒绝。</small></label>
          <label className="xianyu-edit-field"><span>描述</span><TextAreaField aria-label="商品描述" value={description} maxLength={3000} disabled={saving} rows={10} onChange={(event) => setDescription(event.target.value)} /></label>
          {detail.multiSpec
            ? <div className="xianyu-edit-field"><span>规格价格与库存</span>
              <div className="xianyu-edit-skus">
                {skus.map((sku, index) => <div className="xianyu-edit-sku" key={sku.value}>
                  <b>{sku.value}</b>
                  <span className="xianyu-edit-money"><i>¥</i><InputField aria-label={`${sku.value} 售价`} inputMode="decimal" value={sku.priceYuan} disabled={saving} onChange={(event) => setSkus((previous) => previous.map((item, i) => i === index ? { ...item, priceYuan: event.target.value } : item))} /></span>
                  <span className="xianyu-edit-qty"><InputField aria-label={`${sku.value} 库存`} inputMode="numeric" value={sku.quantity} disabled={saving} onChange={(event) => setSkus((previous) => previous.map((item, i) => i === index ? { ...item, quantity: event.target.value } : item))} /><i>件</i></span>
                </div>)}
              </div>
            </div>
            : <div className="xianyu-edit-row">
              <label className="xianyu-edit-field"><span>售价（元）</span><InputField aria-label="售价" inputMode="decimal" value={priceYuan} disabled={saving} onChange={(event) => setPriceYuan(event.target.value)} /></label>
              <label className="xianyu-edit-field"><span>库存</span><InputField aria-label="库存" inputMode="numeric" value={quantity} disabled={saving} onChange={(event) => setQuantity(event.target.value)} /></label>
            </div>}
          <div className="xianyu-edit-field"><span>图片（第一张是主图，点 × 删除；{keep.length + files.length} / {MAX_IMAGES}）</span>
            <div className="xianyu-edit-images">
              {keep.map((url, index) => <div className="xianyu-edit-image" key={url}>
                <img src={url} alt={`图片 ${index + 1}`} />
                {index === 0 && <em>主图</em>}
                <button type="button" aria-label={`删除图片 ${index + 1}`} disabled={saving} onClick={() => setKeep((previous) => previous.filter((item) => item !== url))}>×</button>
              </div>)}
              {files.map((file, index) => <div className="xianyu-edit-image is-new" key={`${file.name}-${index}`}>
                <img src={previews[index]} alt={file.name} />
                <em>新增</em>
                <button type="button" aria-label={`移除新图 ${index + 1}`} disabled={saving} onClick={() => { URL.revokeObjectURL(previews[index]!); setFiles((previous) => previous.filter((_, i) => i !== index)); setPreviews((previous) => previous.filter((_, i) => i !== index)); }}>×</button>
              </div>)}
              {keep.length + files.length < MAX_IMAGES && <label className="xianyu-edit-image xianyu-edit-add">
                <input type="file" accept="image/*" multiple disabled={saving} onChange={(event) => { addFiles(event.target.files); event.currentTarget.value = ''; }} />
                <span>+ 加图</span>
              </label>}
            </div>
            <small>删掉的旧图不会再回来，新图会追加在最后；想换主图就把旧主图删掉，再把新图留在第一位。</small>
          </div>
          {(localError || (state.phase === 'error' && state.error)) && <div className="products-inline-error" role="alert">{localError ?? state.error}</div>}
          <div className="xianyu-edit-actions">
            <button className="btn ghost" type="button" onClick={onClose} disabled={saving}>取消</button>
            <button className="btn primary" type="button" onClick={() => void submit()} disabled={saving}>{saving ? '提交中…' : '保存到闲鱼'}</button>
          </div>
        </>}
      </div>
    </aside>
  </div>;
}
