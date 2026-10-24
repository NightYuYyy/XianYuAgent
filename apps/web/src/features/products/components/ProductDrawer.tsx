import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProductMutationError, ProductVM } from '../types';
import type { ProductPublishPreviewVM } from '../api';
import { toDraftInput, toDraftPatch, type ProductFormErrors } from '../validation';
import { XIANYU_TITLE_MAX, createInitialProductPublishValues, inferProductCategory, serializeAttachments, shouldPreviewOfficialSpecifications, skuRowsToMeta, validateSkuRows, type ProductPublishFormValues } from '../product-publish';
import { ProductPublishForm } from './ProductPublishForm';
import { ProductFormStateBoundary } from './ProductFormStateBoundary';

export function ProductDrawer({ mode, accountId, product, error, saving, onClose, onCreate, onUpdate, onPublish, onSaveDraftImages, loadDraftImages, previewProduct, optimizeDescription }: { mode: 'create' | 'edit'; accountId?: string; product?: ProductVM | null; error: ProductMutationError | null; saving: boolean; onClose: () => void; onCreate: (values: ReturnType<typeof toDraftInput>) => Promise<boolean | ProductVM | null>; onUpdate: (productId: string, patch: ReturnType<typeof toDraftPatch>, version: number) => Promise<boolean | ProductVM | null>; onPublish: (values: ProductPublishFormValues, options?: { draftProductId?: string }) => Promise<boolean>; onSaveDraftImages?: (productId: string, files: File[]) => Promise<unknown>; loadDraftImages?: (product: ProductVM) => Promise<File[]>; previewProduct: (values: Pick<ProductPublishFormValues, 'accountId' | 'title' | 'description' | 'attachments'>) => Promise<ProductPublishPreviewVM>; optimizeDescription: (input: { title: string; description: string }) => Promise<string> }) {
  const initialValues = useMemo<ProductPublishFormValues>(() => createInitialProductPublishValues(accountId, product), [accountId, product]);
  const [values, setValues] = useState<ProductPublishFormValues>(initialValues);
  const [errors, setErrors] = useState<ProductFormErrors>({});
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [queueState, setQueueState] = useState<'draft' | 'publishing'>('draft');
  const [optimizing, setOptimizing] = useState(false);
  const [officialPreview, setOfficialPreview] = useState<ProductPublishPreviewVM | null>(null);
  const [previewState, setPreviewState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const previewRequestId = useRef(0);

  useEffect(() => { setValues(initialValues); setErrors({}); setConfirmationOpen(false); setQueueState('draft'); setOfficialPreview(null); setPreviewState('idle'); previewRequestId.current += 1; }, [initialValues]);

  // 只有还没发到闲鱼的草稿才走「继续发布」：发布成功后后台会把这条草稿归档。
  const draftProductId = mode === 'edit' && product && product.status === 'draft' && !product.externalProductRef ? product.id : undefined;
  const [restoringImages, setRestoringImages] = useState(false);
  useEffect(() => {
    if (!draftProductId || !product || !loadDraftImages) return;
    let cancelled = false;
    setRestoringImages(true);
    void loadDraftImages(product).then((files) => {
      if (cancelled || files.length === 0) return;
      const restored = files.map((file, index) => ({ id: `draft-${product.id}-${index}`, file, url: URL.createObjectURL(file), name: file.name, mimeType: file.type, size: file.size }));
      setValues((previous) => (previous.attachments.length > 0 ? previous : { ...previous, attachments: restored }));
    }).finally(() => { if (!cancelled) setRestoringImages(false); });
    return () => { cancelled = true; };
  }, [draftProductId, product, loadDraftImages]);

  useEffect(() => {
    const imageAttachments = values.attachments.filter((attachment) => Boolean(attachment.file));
    if (!shouldPreviewOfficialSpecifications({ accountId: values.accountId, title: values.title, description: values.description, attachments: imageAttachments })) {
      setOfficialPreview(null);
      setPreviewState('idle');
      return;
    }
    const requestId = ++previewRequestId.current;
    setPreviewState('loading');
    const timer = window.setTimeout(() => {
      void previewProduct({ accountId: values.accountId, title: values.title, description: values.description, attachments: imageAttachments }).then((preview) => {
        if (requestId !== previewRequestId.current) return;
        setOfficialPreview(preview);
        setValues((previous) => {
          const selectedByProperty = new Map((previous.specOverrides ?? []).map((item) => [item.propertyId, item]));
          const nextOverrides = preview.specs.map((spec) => selectedByProperty.get(spec.propertyId) ?? (spec.selected ? { ...spec.selected, propertyId: spec.propertyId, propertyName: spec.propertyName } : undefined)).filter((item): item is NonNullable<typeof item> => Boolean(item));
          return { ...previous, specOverrides: nextOverrides };
        });
        setPreviewState('success');
      }).catch(() => {
        if (requestId !== previewRequestId.current) return;
        setOfficialPreview(null);
        setPreviewState('error');
      });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [previewProduct, values.accountId, values.title, values.description, values.attachments]);

  function update(field: keyof ProductPublishFormValues, value: string) {
    setValues((previous) => {
      const next = { ...previous, [field]: value } as ProductPublishFormValues;
      if (field === 'title' || field === 'description') next.categoryCode = inferProductCategory(next.title, next.description).code;
      return next;
    });
    if (errors[field as keyof ProductFormErrors]) setErrors((previous) => ({ ...previous, [field]: undefined }));
  }

  function draftMultiSpec() {
    return values.multiSpecEnabled ? skuRowsToMeta(values.multiSpecName, values.skuRows) : undefined;
  }

  function draftInput() {
    return toDraftInput({ ...values, publishImages: serializeAttachments(values.attachments), multiSpec: draftMultiSpec() });
  }

  function draftPatch() {
    return toDraftPatch({ ...values, publishImages: serializeAttachments(values.attachments), multiSpec: draftMultiSpec() });
  }

  function validate(requirePublish = false): boolean {
    const nextErrors: ProductFormErrors = {};
    if (!values.accountId.trim()) nextErrors.accountId = '缺少账号上下文，请先在账号管理选择当前账号。';
    if (!values.title.trim()) nextErrors.title = '商品标题不能为空。';
    else if ([...values.title.trim()].length > XIANYU_TITLE_MAX) nextErrors.title = `闲鱼标题最多 ${XIANYU_TITLE_MAX} 个字，当前 ${[...values.title.trim()].length} 个。`;
    if (values.description.length > 2000) nextErrors.description = '商品描述不能超过 2000 个字符。';
    if (requirePublish && values.attachments.filter((attachment) => Boolean(attachment.file)).length < 1) nextErrors.description = '发布到闲鱼前至少上传 1 张商品图片。';
    if (values.multiSpecEnabled) {
      const skuMessage = validateSkuRows(values.multiSpecName, values.skuRows);
      if (skuMessage) nextErrors.priceYuan = skuMessage;
    } else if (!values.priceYuan.trim() || !/^\d+(?:\.\d{1,2})?$/.test(values.priceYuan.trim())) nextErrors.priceYuan = '请填写有效售价。';
    if (values.postageMode === 'fixed' && (!values.postageYuan.trim() || !/^\d+(?:\.\d{1,2})?$/.test(values.postageYuan.trim()))) nextErrors.postageYuan = '选择一口价时必须填写合法邮费。';
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }

  async function saveDraft(closeAfterSave: boolean) {
    if (!validate(false) || saving) return false;
    const result = mode === 'create' ? await onCreate(draftInput()) : await onUpdate(product!.id, draftPatch(), product!.configVersion);
    const saved = result && typeof result === 'object' ? result : null;
    // 草稿文字存完后再把当前图片整体存一份，下次打开草稿能直接继续发布。
    if (saved && onSaveDraftImages) await onSaveDraftImages(saved.id, values.attachments.flatMap((attachment) => (attachment.file ? [attachment.file] : [])));
    const ok = Boolean(result);
    if (ok && closeAfterSave) onClose();
    return ok;
  }

  async function confirmPublish() {
    setConfirmationOpen(false);
    setQueueState('publishing');
    const ok = await onPublish(values, draftProductId ? { draftProductId } : undefined);
    if (ok) onClose();
    else setQueueState('draft');
  }

  async function optimizeDescriptionFromProvider() {
    setOptimizing(true);
    try {
      const description = await optimizeDescription({ title: values.title, description: values.description });
      setValues((previous) => ({ ...previous, description }));
    } finally {
      setOptimizing(false);
    }
  }

  return <div className="products-detail-backdrop product-publish-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="products-detail-panel product-publish-drawer" role="dialog" aria-modal="true" aria-label={mode === 'create' ? '发布商品' : '编辑商品'}>
    <header className="product-publish-header"><div><p className="eyebrow">商品发布 / Draft</p><h2>{mode === 'create' ? '发布商品' : draftProductId ? '继续发布草稿' : '编辑商品'}</h2>{restoringImages && <p className="product-publish-restoring" role="status">正在取回草稿图片…</p>}<p>填写商品信息后，检查附件与物流并提交到当前闲鱼账号。</p></div><div className="product-publish-header-actions"><span className={`products-status products-status-${queueState === 'publishing' ? 'publishing' : 'draft'}`}>{queueState === 'publishing' ? '发布队列中' : '草稿 · 未发布'}</span><button className="icon-button" type="button" aria-label="关闭发布商品" onClick={onClose} disabled={saving}>×</button></div></header>
    <div className="product-publish-body"><ProductFormStateBoundary error={error}><ProductPublishForm values={values} errors={errors} disabled={saving} optimizing={optimizing} officialPreview={officialPreview} previewState={previewState} onSpecOverrideChange={(property, option) => setValues((previous) => ({ ...previous, specOverrides: [...(previous.specOverrides ?? []).filter((item) => item.propertyId !== property.propertyId), { ...option, propertyId: property.propertyId, propertyName: property.propertyName }] }))} onChange={update} onMultiSpecChange={(patch) => { setValues((previous) => ({ ...previous, ...patch })); if (errors.priceYuan) setErrors((previous) => ({ ...previous, priceYuan: undefined })); }} onAttachmentsChange={(attachments) => setValues((previous) => ({ ...previous, attachments }))} onOptimize={() => { void optimizeDescriptionFromProvider(); }} /></ProductFormStateBoundary></div>
    <footer className="product-publish-footer"><div className="product-publish-footer-hint"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4 6v5c0 5 3.4 8.7 8 10 4.6-1.3 8-5 8-10V6Z" /><path d="M12 8v4m0 3h.01" /></svg><span>发布后会立即同步到闲鱼，建议先检查图片、价格、描述与物流模式。</span></div><div className="product-publish-footer-actions"><button className="btn ghost" type="button" onClick={() => void saveDraft(true)} disabled={saving}>{saving ? '保存中…' : '保存草稿'}</button><button className="btn primary" type="button" onClick={() => { if (validate(true)) setConfirmationOpen(true); }} disabled={saving}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>发布到闲鱼</button></div></footer>
    {confirmationOpen && <div className="product-publish-confirmation"><h3>确认发布到闲鱼？</h3><p>将使用当前账号发布 1 个商品，{values.multiSpecEnabled ? `${values.skuRows.length} 个规格（${values.multiSpecName.trim() || '规格'}）按各自价格发布` : `价格 ¥${values.priceYuan || '0'}，库存按闲鱼官方逻辑处理`}，所在地 {values.location.trim() || '未设置'}。确认后会进入服务端发布队列。</p><div className="product-publish-confirmation-actions"><button className="btn ghost" type="button" onClick={() => setConfirmationOpen(false)}>返回修改</button><button className="btn warning" type="button" onClick={() => void confirmPublish()}>确认发布</button></div></div>}
  </aside></div>;
}
