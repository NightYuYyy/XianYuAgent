import { createSkuRow, type ProductPublishSkuRow } from '../product-publish';
import { InputField } from '../../../shared/ui/InputField';

export type ProductSkuEditorPatch = Partial<{ multiSpecEnabled: boolean; multiSpecName: string; skuRows: ProductPublishSkuRow[] }>;

const MAX_ROWS = 50;

/**
 * 发布表单里的单维度多规格编辑：一个规格名 + 若干规格值，每个规格值独立售价与库存。
 * 自动发货按「规格名:规格值」匹配多规格卡券批次，所以这里的名称要和卡券里填的一致。
 */
export function ProductSkuEditor({ enabled, name, rows, disabled, error, onChange }: {
  enabled: boolean;
  name: string;
  rows: ProductPublishSkuRow[];
  disabled?: boolean;
  error?: string;
  onChange: (patch: ProductSkuEditorPatch) => void;
}) {
  function toggle(next: boolean) {
    if (next && rows.length === 0) onChange({ multiSpecEnabled: true, skuRows: [createSkuRow(), createSkuRow()] });
    else onChange({ multiSpecEnabled: next });
  }

  function updateRow(id: string, patch: Partial<Omit<ProductPublishSkuRow, 'id'>>) {
    onChange({ skuRows: rows.map((row) => row.id === id ? { ...row, ...patch } : row) });
  }

  return <div className="product-publish-sku-editor" data-testid="product-sku-editor">
    <label className="product-publish-sku-toggle">
      <input type="checkbox" checked={enabled} disabled={disabled} onChange={(event) => toggle(event.target.checked)} />
      <span>多规格（按规格分别定价）</span>
    </label>
    <small className="product-publish-sku-hint">例如规格名「卡种」，规格值「测试卡 / 天卡」。开启后买家下单会带上规格，自动发货会按同名多规格卡券批次匹配发货。</small>
    {enabled && <>
      <label className="product-publish-sku-name"><span>规格名称 <em>*</em></span><InputField aria-label="规格名称" value={name} maxLength={20} disabled={disabled} placeholder="例如：卡种" onChange={(event) => onChange({ multiSpecName: event.target.value })} /></label>
      <div className="product-publish-sku-rows">
        <div className="product-publish-sku-head"><span>规格值</span><span>售价（¥）</span><span>库存</span><span /></div>
        {rows.map((row, index) => <div className="product-publish-sku-row" key={row.id}>
          <InputField aria-label={`规格值 ${index + 1}`} value={row.value} maxLength={30} disabled={disabled} placeholder="例如：天卡" onChange={(event) => updateRow(row.id, { value: event.target.value })} />
          <InputField aria-label={`售价 ${index + 1}`} inputMode="decimal" value={row.priceYuan} disabled={disabled} placeholder="0.00" onChange={(event) => updateRow(row.id, { priceYuan: event.target.value })} />
          <InputField aria-label={`库存 ${index + 1}`} inputMode="numeric" value={row.quantity} disabled={disabled} placeholder="99" onChange={(event) => updateRow(row.id, { quantity: event.target.value })} />
          <button className="product-publish-sku-remove" type="button" aria-label={`删除规格 ${index + 1}`} disabled={disabled || rows.length <= 1} onClick={() => onChange({ skuRows: rows.filter((item) => item.id !== row.id) })}>×</button>
        </div>)}
      </div>
      <button className="product-publish-sku-add" type="button" disabled={disabled || rows.length >= MAX_ROWS} onClick={() => onChange({ skuRows: [...rows, createSkuRow()] })}>+ 添加规格</button>
      {error && <small className="product-publish-error">{error}</small>}
    </>}
  </div>;
}
