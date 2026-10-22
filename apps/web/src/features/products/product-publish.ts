import type { ProductPublishImageMeta, ProductPublishMeta, ProductPublishMultiSpecMeta, ProductVM } from './types';

export type PublishAttachment = ProductPublishImageMeta & {
  id: string;
  url: string;
  file?: File;
};

export type ProductPostageMode = 'free' | 'distance' | 'fixed' | 'none';

export type ProductPublishSpec = {
  label: string;
  value: string;
  source: 'description' | 'image' | 'official';
};

export type ProductPublishSpecOption = {
  valueId?: string;
  valueName?: string;
  text: string;
  channelCatId?: string;
  catId?: string;
  catName?: string;
  tbCatId?: string;
};

export type ProductPublishSpecPreview = {
  propertyId: string;
  propertyName: string;
  selected?: ProductPublishSpecOption;
  options: ProductPublishSpecOption[];
};

export type ProductPublishSpecOverride = ProductPublishSpecOption & {
  propertyId: string;
  propertyName: string;
};

export type ProductPublishFormValues = {
  accountId: string;
  title: string;
  description: string;
  categoryCode: string;
  priceMinor: string;
  priceYuan: string;
  originalPriceYuan: string;
  postageMode: ProductPostageMode;
  postageYuan: string;
  location: string;
  attachments: PublishAttachment[];
  specOverrides?: ProductPublishSpecOverride[];
  multiSpecEnabled: boolean;
  multiSpecName: string;
  skuRows: ProductPublishSkuRow[];
};

export type ProductPublishSkuRow = {
  id: string;
  value: string;
  priceYuan: string;
  quantity: string;
};

export const DEFAULT_PRODUCT_DESCRIPTION = '全新降噪蓝牙耳机 Pro，通勤和居家都适合。\n• 主动降噪，地铁 / 飞机环境更安静\n• 单次续航约 8 小时，充电盒可补电 3 次\n• 支持双设备连接，Type-C 充电\n\n成色：全新未拆封｜发货：24 小时内';

export function formatYuan(minor?: number): string {
  return minor === undefined ? '' : (minor / 100).toFixed(2).replace(/\.00$/, '');
}

export function yuanToMinor(value?: string): number | undefined {
  if (!value?.trim()) return undefined;
  const numeric = Number(value.trim());
  return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric * 100) : undefined;
}

export function inferProductCategory(title: string, description: string): { code: string; label: string; hint: string } {
  const text = `${title} ${description}`;
  if (/耳机|蓝牙|降噪|音箱/u.test(text)) return { code: 'digital.audio', label: '数码 › 耳机 / 音箱', hint: '已根据商品描述自动选择' };
  if (/收纳|家居|盒子/u.test(text)) return { code: 'home.storage', label: '家居 › 收纳', hint: '已根据商品描述自动选择' };
  if (/保温杯|水杯|杯子/u.test(text)) return { code: 'home.kitchen', label: '家居 › 厨具 / 水具', hint: '已根据商品描述自动选择' };
  return { code: '', label: '待识别', hint: '继续完善标题或描述后自动选择' };
}

export function inferProductSpecs(title: string, description: string, attachments: PublishAttachment[]): ProductPublishSpec[] {
  const text = `${title} ${description}`.trim();
  const specs: ProductPublishSpec[] = [];
  const category = inferProductCategory(title, description);
  if (category.label !== '待识别') specs.push({ label: '类目', value: category.label, source: 'official' });
  const condition = text.match(/全新未拆封|全新|九成新|八成新|二手|轻微使用痕迹/u)?.[0];
  if (condition) specs.push({ label: '成色', value: condition, source: 'description' });
  const size = text.match(/(?:尺码|码数)\s*[:：]?\s*(XS|S|M|L|XL|XXL|均码)/iu)?.[1] ?? text.match(/\b(XXL|XL|XS|M|L|S)\b/u)?.[1];
  if (size) specs.push({ label: '尺码', value: size.toUpperCase(), source: 'description' });
  const color = text.match(/(?:颜色|色系)\s*[:：]?\s*(黑色|白色|蓝色|红色|粉色|绿色|灰色|米色|杏色)/u)?.[1];
  if (color) specs.push({ label: '颜色', value: color, source: 'description' });
  if (attachments.length > 0) specs.push({ label: '图片', value: `${attachments.length} 张，发布时交给闲鱼官方识别`, source: 'image' });
  if (specs.length === 0) specs.push({ label: '规格', value: '补充图片或描述后自动确认', source: 'official' });
  return specs;
}

export function shouldPreviewOfficialSpecifications(input: Pick<ProductPublishFormValues, 'accountId' | 'title' | 'description' | 'attachments'>): boolean {
  return Boolean(input.accountId.trim() && input.title.trim() && input.description.trim() && input.attachments.some((attachment) => Boolean(attachment.file)));
}

function normalizePostageMode(value: unknown): ProductPostageMode {
  if (value === 'distance') return 'distance';
  if (value === 'fixed' || value === 'buyer') return 'fixed';
  if (value === 'none') return 'none';
  return 'free';
}

export function publishMetaFromProduct(product?: ProductVM | null): ProductPublishMeta {
  const raw = product?.attributesJson?.publish;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const value = raw as Record<string, unknown>;
  return {
    originalPriceMinor: typeof value.originalPriceMinor === 'number' ? value.originalPriceMinor : undefined,
    postageMode: normalizePostageMode(value.postageMode),
    postageMinor: typeof value.postageMinor === 'number' ? value.postageMinor : undefined,
    location: typeof value.location === 'string' ? value.location : undefined,
    multiSpec: readMultiSpecMeta(value.multiSpec),
    images: Array.isArray(value.images) ? value.images.filter((item): item is ProductPublishImageMeta => Boolean(item && typeof item === 'object' && typeof (item as ProductPublishImageMeta).name === 'string' && typeof (item as ProductPublishImageMeta).mimeType === 'string')) : [],
  };
}

export function createInitialProductPublishValues(accountId?: string, product?: ProductVM | null): ProductPublishFormValues {
  const meta = publishMetaFromProduct(product);
  const category = inferProductCategory(product?.title ?? '', product?.description ?? '');
  return {
    accountId: product?.accountId ?? accountId ?? '',
    title: product?.title ?? '',
    description: product?.description ?? '',
    categoryCode: product?.categoryCode ?? category.code,
    priceMinor: product?.priceMinor === undefined ? '' : String(product.priceMinor),
    priceYuan: formatYuan(product?.priceMinor),
    originalPriceYuan: formatYuan(meta.originalPriceMinor),
    postageMode: normalizePostageMode(meta.postageMode),
    postageYuan: formatYuan(meta.postageMinor),
    location: meta.location ?? '',
    attachments: [],
    multiSpecEnabled: Boolean(meta.multiSpec),
    multiSpecName: meta.multiSpec?.name ?? '',
    skuRows: (meta.multiSpec?.skus ?? []).map((sku) => createSkuRow({ value: sku.value, priceYuan: formatYuan(sku.priceMinor), quantity: String(sku.quantity) })),
  };
}

export function serializeAttachments(attachments: PublishAttachment[]): ProductPublishImageMeta[] {
  return attachments.map(({ id: _id, url: _url, file: _file, ...meta }) => meta);
}

export function readMultiSpecMeta(value: unknown): ProductPublishMultiSpecMeta | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.name !== 'string' || !Array.isArray(source.skus)) return undefined;
  const skus = source.skus.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const sku = item as Record<string, unknown>;
    if (typeof sku.value !== 'string' || typeof sku.priceMinor !== 'number') return [];
    return [{ value: sku.value, priceMinor: sku.priceMinor, quantity: typeof sku.quantity === 'number' ? sku.quantity : 0 }];
  });
  return skus.length > 0 ? { name: source.name, skus } : undefined;
}

export function createSkuRow(partial: Partial<Omit<ProductPublishSkuRow, 'id'>> = {}): ProductPublishSkuRow {
  const id = globalThis.crypto?.randomUUID?.() ?? `sku-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return { id, value: partial.value ?? '', priceYuan: partial.priceYuan ?? '', quantity: partial.quantity ?? '99' };
}

const MONEY_PATTERN = /^\d+(?:\.\d{1,2})?$/;

/** 校验多规格表单；返回第一条可读错误，合法时返回 undefined。 */
export function validateSkuRows(name: string, rows: ProductPublishSkuRow[]): string | undefined {
  if (!name.trim()) return '请填写规格名称，例如「卡种」。';
  if (name.trim().length > 20) return '规格名称不能超过 20 个字符。';
  if (rows.length === 0) return '至少添加一个规格。';
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const label = `第 ${index + 1} 个规格`;
    const value = row.value.trim();
    if (!value) return `${label}的规格值不能为空。`;
    if (value.includes(':')) return `${label}的规格值不能包含冒号。`;
    if (seen.has(value)) return `规格值重复：${value}。`;
    seen.add(value);
    if (!MONEY_PATTERN.test(row.priceYuan.trim()) || Number(row.priceYuan) <= 0) return `${label}（${value}）请填写大于 0 的售价。`;
    if (!/^\d+$/.test(row.quantity.trim()) || Number(row.quantity) > 999_999) return `${label}（${value}）的库存必须是 0 到 999999 的整数。`;
  }
  return undefined;
}

export function skuRowsToMeta(name: string, rows: ProductPublishSkuRow[]): ProductPublishMultiSpecMeta {
  return {
    name: name.trim(),
    skus: rows.map((row) => ({ value: row.value.trim(), priceMinor: yuanToMinor(row.priceYuan) ?? 0, quantity: Number(row.quantity.trim()) || 0 })),
  };
}

export function minSkuPriceMinor(rows: ProductPublishSkuRow[]): number {
  const prices = rows.map((row) => yuanToMinor(row.priceYuan)).filter((value): value is number => typeof value === 'number' && value > 0);
  return prices.length > 0 ? Math.min(...prices) : 0;
}
