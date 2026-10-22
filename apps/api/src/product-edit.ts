import type { ProductRecord, Store } from './domain.js';
import { ServiceError } from './services.js';
import type { MtopResult, XianyuMtopClient } from './xianyu-mtop.js';

/**
 * 已发布商品的编辑（卖家后台接口，移植自 19000 项目）。
 *
 * 流程：editdetail 拉平台当前详情作为快照 → 在快照上覆盖要改的字段 → edit 全量提交。
 * edit 是全量覆盖，不是增量，所以快照里的图片、运费、地址、服务承诺、规格都要原样回传，
 * 否则平台上的对应内容会被清空。
 */
export const PRODUCT_EDIT_DETAIL_API = 'mtop.idle.pc.backend.idleitem.editdetail';
export const PRODUCT_EDIT_API = 'mtop.idle.pc.backend.idleitem.edit';
const SELLER_REFERER = 'https://seller.goofish.com/?site=COMMONPRO';
const SELLER_EXTRA_PARAMS = { idle_site_biz_code: 'COMMONPRO', spm_cnt: 'a21107h.42826273.0.0' };
const SELLER_HEADERS = { idle_site_biz_code: 'COMMONPRO', idle_user_group_member_id: '' };

export interface ProductEditSkuInput {
  value: string;
  priceMinor?: number;
  quantity?: number;
}

export interface ProductEditInput {
  adminId: string;
  productId: string;
  title?: string;
  description?: string;
  /** 单规格售价（分）；多规格商品改价请用 skus */
  priceMinor?: number;
  /** 多规格：按规格值匹配快照里的 SKU，只改给出的价格/库存 */
  skus?: ProductEditSkuInput[];
  quantity?: number;
  requestId: string;
  traceId: string;
}

export interface ProductEditResult {
  product: ProductRecord;
  itemId: string;
  changed: string[];
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? v as Rec : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string => (v === undefined || v === null ? '' : String(v).trim());
const asBool = (v: unknown): boolean => v === true || text(v).toLowerCase() === 'true' || text(v) === '1';
const asInt = (v: unknown, fallback = 0): number => { const n = Number.parseInt(text(v), 10); return Number.isFinite(n) ? n : fallback; };

export class ProductEditService {
  constructor(
    private readonly xianyu: XianyuMtopClient,
    private readonly store: Store,
    private readonly audit: (input: { actorId: string; action: string; targetRef?: string; requestId: string; traceId: string; payload: unknown; accountId?: string }) => Promise<string>,
  ) {}

  private async callSeller(adminId: string, accountId: string, api: string, data: Rec): Promise<MtopResult> {
    return this.xianyu.call(adminId, accountId, api, '1.0', data, SELLER_EXTRA_PARAMS, { referer: SELLER_REFERER, headers: SELLER_HEADERS });
  }

  private async loadProduct(adminId: string, productId: string): Promise<{ product: ProductRecord; itemId: string }> {
    const product = await this.store.getProduct(adminId, productId);
    if (!product) throw new ServiceError(404, 'NOT_FOUND', 'product not found');
    const itemId = text(product.externalProductRef);
    if (!itemId) throw new ServiceError(422, 'VALIDATION_FAILED', '商品还没有发布到闲鱼，没有可编辑的链接');
    return { product, itemId };
  }

  /** 拉取平台当前的编辑详情（原样返回，便于排查字段）。 */
  async getEditDetail(adminId: string, productId: string): Promise<{ itemId: string; detail: Rec }> {
    const { product, itemId } = await this.loadProduct(adminId, productId);
    const result = await this.callSeller(adminId, product.accountId, PRODUCT_EDIT_DETAIL_API, { itemId });
    if (!result.success) throw new ServiceError(502, result.errorCode ?? 'XIANYU_EDIT_DETAIL_FAILED', result.message ?? '获取闲鱼商品编辑详情失败');
    const detail = rec(rec(result.response).data);
    if (!text(detail.itemId)) throw new ServiceError(502, 'XIANYU_EDIT_DETAIL_EMPTY', '闲鱼未返回商品详情（可能不是鱼小铺账号，或商品不属于该账号）');
    return { itemId, detail };
  }

  async edit(input: ProductEditInput): Promise<ProductEditResult> {
    const title = input.title?.trim();
    const description = input.description?.trim();
    if (title !== undefined && !title) throw new ServiceError(422, 'VALIDATION_FAILED', '标题不能为空');
    if (description !== undefined && !description) throw new ServiceError(422, 'VALIDATION_FAILED', '描述不能为空');
    if (input.priceMinor !== undefined && (!Number.isSafeInteger(input.priceMinor) || input.priceMinor <= 0)) throw new ServiceError(422, 'VALIDATION_FAILED', '价格必须大于 0');
    const { product, itemId } = await this.loadProduct(input.adminId, input.productId);
    const { detail } = await this.getEditDetail(input.adminId, input.productId);

    const { payload, changed } = buildEditPayload(detail, itemId, { title, description, priceMinor: input.priceMinor, skus: input.skus, quantity: input.quantity });
    if (changed.length === 0) throw new ServiceError(422, 'VALIDATION_FAILED', '没有要修改的内容');

    const result = await this.callSeller(input.adminId, product.accountId, PRODUCT_EDIT_API, { inputJson: JSON.stringify(payload) });
    if (!result.success) throw new ServiceError(502, result.errorCode ?? 'XIANYU_EDIT_FAILED', result.message ?? '闲鱼商品编辑失败');
    const failure = businessFailure(rec(result.response));
    if (failure) throw new ServiceError(502, 'XIANYU_EDIT_REJECTED', `闲鱼拒绝了本次编辑：${failure}`);

    // 同步本地记录
    const patch: Rec = {};
    if (title !== undefined) patch.title = title;
    if (description !== undefined) patch.description = description;
    if (input.priceMinor !== undefined) patch.priceMinor = input.priceMinor;
    const updated = Object.keys(patch).length > 0
      ? await this.store.updateProduct({ adminId: input.adminId, productId: product.id, expectedConfigVersion: product.configVersion, patch })
      : product;
    await this.audit({ actorId: input.adminId, action: 'product.xianyu_edited', targetRef: product.id, requestId: input.requestId, traceId: input.traceId, accountId: product.accountId, payload: { itemId, changed } });
    return { product: updated ?? product, itemId, changed };
  }
}

/** editdetail 里的值几乎都是字符串（"true"、"800"），按 edit 请求的真类型重建。 */
function normalizeImage(entry: Rec): Rec {
  const extra = rec(entry.extraInfo);
  const url = text(entry.url);
  return {
    extraInfo: { isH: asBool(extra.isH) ? 'true' : 'false', isT: asBool(extra.isT) ? 'true' : 'false', raw: asBool(extra.raw) ? 'true' : 'false' },
    heightSize: asInt(entry.heightSize, 800),
    isQrCode: asBool(entry.isQrCode),
    labels: list(entry.labels),
    major: asBool(entry.major),
    templateIndex: text(entry.templateIndex) || '0',
    thumbnail: text(entry.thumbnail) || url,
    type: asInt(entry.type),
    url,
    widthSize: asInt(entry.widthSize, 800),
    status: 'done',
  };
}

function normalizePostFee(fee: Rec): Rec {
  return {
    canFreeShipping: asBool(fee.canFreeShipping),
    supportFreight: asBool(fee.supportFreight),
    onlyTakeSelf: asBool(fee.onlyTakeSelf),
    postPriceInCent: String(asInt(fee.postPriceInCent)),
    templateId: text(fee.templateId) || '0',
    idleTemplateId: text(fee.idleTemplateId) || '0',
  };
}

function normalizeUserRights(items: unknown[]): Rec[] {
  const out = items.map((item) => { const r = rec(item); return { enable: asBool(r.enable), serviceCode: text(r.serviceCode) }; }).filter((r) => r.serviceCode);
  return out.length > 0 ? out : [{ enable: false, serviceCode: 'SKILL_PLAY_NO_MIND' }];
}

function normalizeAddress(addr: Rec): Rec | undefined {
  const keys = ['area', 'addressType', 'aoiId', 'aoiName', 'cainiaoDivision', 'city', 'divisionId', 'gps', 'poiId', 'poiName', 'prov'];
  const out: Rec = {};
  for (const key of keys) {
    const value = addr[key];
    if (value === undefined || value === null || text(value) === '') continue;
    out[key] = key === 'addressType' ? asInt(value) : key === 'divisionId' ? (Number.isFinite(Number(value)) ? Number(value) : value) : value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function buildEditPayload(detail: Rec, itemId: string, overrides: { title?: string; description?: string; priceMinor?: number; skus?: ProductEditSkuInput[]; quantity?: number }): { payload: Rec; changed: string[] } {
  const changed: string[] = [];
  const textDto = rec(detail.itemTextDTO);
  const title = overrides.title ?? text(textDto.title ?? detail.title);
  const description = overrides.description ?? text(textDto.desc ?? detail.desc ?? detail.description);
  if (overrides.title !== undefined && overrides.title !== text(textDto.title ?? detail.title)) changed.push('title');
  if (overrides.description !== undefined && overrides.description !== text(textDto.desc ?? detail.desc ?? detail.description)) changed.push('description');

  // 规格：editdetail 不返回 itemProperties，从 itemSkuList 的 propertyList 反推
  const rawSkus = list(detail.itemSkuList).map(rec).filter((s) => list(s.propertyList).length > 0);
  const multiSpec = rawSkus.length > 0;
  let itemSkuList: Rec[] = [];
  let itemProperties: Rec[] = [];
  if (multiSpec) {
    const propertyNames: string[] = [];
    const valuesByName = new Map<string, string[]>();
    itemSkuList = rawSkus.map((sku) => {
      const propertyList = list(sku.propertyList).map(rec).map((p) => ({ propertyText: text(p.propertyText), valueText: text(p.valueText) }));
      for (const p of propertyList) {
        if (!valuesByName.has(p.propertyText)) { valuesByName.set(p.propertyText, []); propertyNames.push(p.propertyText); }
        const values = valuesByName.get(p.propertyText)!;
        if (!values.includes(p.valueText)) values.push(p.valueText);
      }
      let priceInCent = String(asInt(sku.priceInCent ?? sku.price));
      let quantity = asInt(sku.quantity);
      const override = overrides.skus?.find((o) => propertyList.some((p) => p.valueText === o.value.trim()));
      if (override) {
        if (override.priceMinor !== undefined && String(override.priceMinor) !== priceInCent) { priceInCent = String(override.priceMinor); changed.push(`sku:${override.value}:price`); }
        if (override.quantity !== undefined && override.quantity !== quantity) { quantity = override.quantity; changed.push(`sku:${override.value}:quantity`); }
      }
      return { priceInCent, quantity, propertyList };
    });
    const imageByProperty = new Map<string, Rec>();
    for (const entry of list(detail.propertyImageList).map(rec)) {
      const prop = rec(entry.property);
      if (text(entry.url)) imageByProperty.set(`${text(prop.propertyText)}\u0000${text(prop.valueText)}`, entry);
    }
    itemProperties = propertyNames.map((name) => ({
      propertyName: name,
      supportImage: (valuesByName.get(name) ?? []).some((v) => imageByProperty.has(`${name}\u0000${v}`)),
      propertyValues: (valuesByName.get(name) ?? []).map((v) => ({ propertyValue: v })),
    }));
  }

  const priceDto = rec(detail.itemPriceDTO);
  let itemPriceDTO: Rec = {};
  if (!multiSpec) {
    const current = asInt(priceDto.priceInCent);
    const priceInCent = overrides.priceMinor ?? current;
    if (overrides.priceMinor !== undefined && overrides.priceMinor !== current) changed.push('price');
    itemPriceDTO = { priceInCent: String(priceInCent), ...(asInt(priceDto.origPriceInCent) > 0 ? { origPriceInCent: String(asInt(priceDto.origPriceInCent)) } : {}) };
  }
  let quantity: string | number = multiSpec ? '1' : asInt(detail.quantity, 1);
  if (!multiSpec && overrides.quantity !== undefined && overrides.quantity !== quantity) { quantity = overrides.quantity; changed.push('quantity'); }

  const catDto = rec(detail.itemCatDTO);
  const itemCatDTO: Rec = { catId: text(catDto.catId), catName: text(catDto.catName), channelCatId: text(catDto.channelCatId), tbCatId: text(catDto.tbCatId) };
  if (text(catDto.leafId)) itemCatDTO.leafId = text(catDto.leafId);

  const payload: Rec = {
    freebies: asBool(detail.freebies),
    itemTypeStr: text(detail.itemTypeStr) || 'b',
    quantity,
    simpleItem: 'true',
    imageInfoDOList: list(detail.imageInfoDOList).map(rec).filter((e) => text(e.url)).map(normalizeImage),
    itemTextDTO: { desc: description, title, titleDescSeparate: true },
    itemLabelExtList: list(detail.itemLabelExtList),
    userRightsProtocols: normalizeUserRights(list(detail.userRightsProtocols)),
    itemPostFeeDTO: normalizePostFee(rec(detail.itemPostFeeDTO)),
    defaultPrice: false,
    itemPriceDTO,
    uniqueCode: `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`,
    sourceId: 'pcBackendPublish',
    bizcode: 'pcMainPublish',
    publishScene: 'pcBackendPublish',
    itemCatDTO,
    itemId,
  };
  const addr = normalizeAddress(rec(detail.itemAddrDTO));
  if (addr) payload.itemAddrDTO = addr;
  if (multiSpec) { payload.itemProperties = itemProperties; payload.itemSkuList = itemSkuList; }
  if (list(detail.propertyImageList).length > 0) payload.propertyImageList = list(detail.propertyImageList);
  return { payload, changed };
}

/** ret 成功但 data 里业务失败的情况（抓包里 edit 响应体为空，成功结构未知，按通用标志位判断）。 */
function businessFailure(response: Rec): string {
  const data = rec(response.data);
  if (Object.keys(data).length === 0) return '';
  if (data.success === false || text(data.success).toLowerCase() === 'false') return text(data.msg ?? data.message ?? data.errorMsg) || '业务失败';
  const code = text(data.code);
  if (code && !['0', '200', 'success', 'SUCCESS'].includes(code)) return `${code} ${text(data.msg ?? data.message)}`.trim();
  return '';
}
