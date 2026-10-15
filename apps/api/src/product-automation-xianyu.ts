import type {
  AutomationExecutionPort,
  AutomationExternalResult,
  AutomationOrderSnapshot,
} from './product-automation.js';
import type { ProductAutomationExecutionAdapter } from './product-automation-trigger.js';
import type { Store } from './domain.js';
import { XianyuMtopClient, type XianyuExternalMutationResult, type XianyuOrderDetailSummary } from './xianyu-mtop.js';
import type { XianyuImService } from './xianyu-im-service.js';
import type { CouponAssetService } from './coupon-assets.js';
import { buildCouponContext, parseSkuSpec, resolveCouponDelivery } from './coupon-delivery.js';

/**
 * Live product-automation adapter.
 *
 * The adapter is deliberately thin: local reservation state and order facts
 * stay authoritative in Store, while Xianyu MTOP/IM remain the only external
 * mutation surfaces. The trigger-level live gate must pass before any method
 * in this adapter is reached.
 */
export class XianyuProductAutomationExecutionAdapter implements ProductAutomationExecutionAdapter {
  readonly readiness = 'ready' as const;
  readonly readinessCode = 'XIANYU_EXTERNAL_EXECUTION_READY';

  constructor(
    private readonly store: Store,
    private readonly getMtop: () => XianyuMtopClient,
    private readonly getIm: () => XianyuImService | undefined,
    private readonly audit?: (input: { adminId: string; action: string; accountId?: string; orderNo?: string; executionKey?: string; payload?: unknown }) => Promise<unknown> | unknown,
    private readonly couponAssets?: CouponAssetService,
  ) {}

  async reserveCoupon(input: Parameters<AutomationExecutionPort['reserveCoupon']>[0]): Promise<{ reservationId: string; quantity: number; noLogisticsForm?: boolean; tradeText?: string }> {
    const adminId = requireAdminId(input.adminId);
    const batches = await Promise.all(input.batchIds.map((batchId) => this.store.getCouponBatch(adminId, batchId)));
    const usableBatches = selectBatchesForSpec(batches.filter((batch): batch is NonNullable<typeof batch> => Boolean(batch)), input.skuSpec);
    if (usableBatches.length === 0) throw new Error('COUPON_SPEC_MISMATCH');
    const requiresIm = input.purpose === 'gift' || usableBatches.some((batch) => !(input.purpose === 'delivery' && batch.metadata?.useNoLogisticsForm === true));
    if (requiresIm) {
      const im = this.getIm();
      if (im && typeof im.isReady === 'function' && !await im.isReady(adminId, input.accountId)) throw new Error('XIANYU_IM_NOT_READY');
    }
    const reservation = await this.store.reserveCoupon({
      adminId,
      accountId: input.accountId,
      batchIds: usableBatches.map((batch) => batch.id),
      quantity: input.quantity,
      executionKey: input.executionKey,
      purpose: input.purpose,
    });
    const formBatch = usableBatches.find((batch) => batch.metadata?.useNoLogisticsForm === true);
    const noLogisticsForm = input.purpose === 'delivery' && Boolean(formBatch);
    const tradeText = noLogisticsForm ? formBatch?.metadata?.textContent?.trim() : undefined;
    if (input.purpose === 'delivery' && input.orderNo) {
      await this.store.saveDeliveryConfirmation({ adminId, accountId: input.accountId, orderNo: input.orderNo, executionKey: input.executionKey, noLogisticsForm, tradeText });
    }
    await this.recordAudit({ adminId, action: 'product.automation.coupon.reserved', accountId: input.accountId, executionKey: input.executionKey, payload: { reservationId: reservation.reservationId, quantity: reservation.quantity, purpose: input.purpose, batchIds: usableBatches.map((batch) => batch.id), noLogisticsForm } });
    return { reservationId: reservation.reservationId, quantity: reservation.quantity, noLogisticsForm, tradeText };
  }

  async sendCoupon(input: Parameters<AutomationExecutionPort['sendCoupon']>[0]): Promise<AutomationExternalResult> {
    if (input.purpose !== 'delivery') return this.sendCouponWithVerifiedPlan(input);
    try {
      return await this.store.withVerifiedPartialDeliveryPlan({ accountId: input.accountId, orderNo: input.orderNo, executionKey: input.executionKey, reservationId: input.reservationId }, () => this.sendCouponWithVerifiedPlan(input));
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'DELIVERY_RECOVERY_COUPON_PLAN_CHANGED') throw error;
      await this.store.quarantineCouponReservation({ adminId: requireAdminId(input.adminId), executionKey: input.executionKey, reason: error.message });
      return unknownExternal(error.message, 'verified coupon plan changed before remaining content was sent');
    }
  }

  private async sendCouponWithVerifiedPlan(input: Parameters<AutomationExecutionPort['sendCoupon']>[0]): Promise<AutomationExternalResult> {
    const adminId = requireAdminId(input.adminId);
    let sentAtLeastOne = false;
    const reservation = await this.store.getCouponReservation({ adminId, reservationId: input.reservationId, executionKey: input.executionKey });
    if (!reservation) return failedExternal('COUPON_RESERVATION_NOT_FOUND', 'coupon reservation not found');
    if (reservation.status === 'committed') return { status: 'succeeded', externalRef: `coupon-reservation:${reservation.reservationId}` };
    if (reservation.status !== 'reserved') return failedExternal('COUPON_RESERVATION_NOT_ACTIVE', 'coupon reservation is not active');
    if (input.purpose === 'delivery' && !await this.store.bindDeliveryReservation({ adminId, accountId: input.accountId, orderNo: input.orderNo, reservationId: input.reservationId, executionKey: input.executionKey })) {
      return unknownExternal('DELIVERY_RESERVATION_FENCE_FAILED', 'reservation expired or order send is already fenced');
    }

    const order = await this.loadScopedOrder(adminId, input.accountId, input.orderNo, input.productId, input.itemId);
    if (!order) return failedExternal('ORDER_NOT_FOUND', 'order or product scope not found');
    if (input.purpose === 'delivery') {
      const live = await this.readOrder({ adminId, accountId: input.accountId, orderNo: input.orderNo, productId: input.productId, itemId: input.itemId, itemTitle: input.itemTitle });
      if (!live) return unknownExternal('AUTHORITATIVE_ORDER_UNAVAILABLE', 'platform order facts are unavailable before send');
      if (live.paymentStatus !== 'paid' || live.orderStatus !== 'open' || live.deliveryStatus !== 'pending' || live.afterSalesStatus !== 'none') return failedExternal('ORDER_NOT_DELIVERABLE', 'platform order is not deliverable');
    }
    try {
      const batches = await Promise.all(reservation.batchIds.map((batchId) => this.store.getCouponBatch(adminId, batchId)));
      const noLogisticsBatchIds: string[] = [];
      const deliverableItems = [];
      for (const item of reservation.items) {
        const batch = batches.find((candidate) => candidate?.id === item.batchId) ?? await this.store.getCouponBatch(adminId, item.batchId);
        if (!batch) return failedExternal('COUPON_BATCH_NOT_FOUND', 'coupon batch not found');
        const useNoLogisticsForm = input.purpose === 'delivery' && batch.metadata?.useNoLogisticsForm === true;
        if (useNoLogisticsForm && (batch.purpose !== 'text' || !batch.metadata?.textContent?.trim())) return failedExternal('NO_LOGISTICS_FORM_INVALID', 'no logistics form requires fixed text content');
        if (useNoLogisticsForm) {
          noLogisticsBatchIds.push(batch.id);
          if (input.purpose !== 'delivery') await waitForDelay(Number(batch.metadata?.delaySeconds ?? 0));
        } else {
          deliverableItems.push({ item, batch });
        }
      }
      if (deliverableItems.length === 0) {
        await this.recordAudit({ adminId, action: 'product.automation.coupon.no_logistics_pending', accountId: input.accountId, orderNo: input.orderNo, executionKey: input.executionKey, payload: { reservationId: reservation.reservationId, batchIds: noLogisticsBatchIds } });
        return { status: 'succeeded', externalRef: `no-logistics:${reservation.reservationId}` };
      }
      if (!order.conversationId) return failedExternal('CONVERSATION_MISSING', 'order conversation is missing');
      const im = this.getIm();
      if (!im) return retryableUnknownExternal('XIANYU_IM_NOT_READY', 'xianyu im service is not ready');
      if (typeof im.isReady === 'function' && !await im.isReady(adminId, input.accountId)) return retryableUnknownExternal('XIANYU_IM_NOT_READY', 'xianyu im service is not ready before coupon send');
      const account = await this.store.getAccount(adminId, input.accountId);
      const product = order.productId ? await this.store.getProduct(adminId, order.productId) : undefined;
      const orderSpec = parseSkuSpec(order.skuSpec);
      const context = buildCouponContext({
        orderId: order.orderNo,
        itemId: order.itemId,
        itemDetail: product?.description ?? '',
        itemTitle: order.itemTitle,
        buyerName: order.buyerName,
        buyerId: order.buyerId,
        cookieId: input.accountId,
        sellerName: account?.remark || account?.displayName || account?.sellerRef || '',
        specName: orderSpec.specName,
        specValue: orderSpec.specValue,
        orderAmount: String((order.amountMinor ?? 0) / 100),
        orderQuantity: String(order.quantity ?? reservation.quantity),
      });
      let externalMessageRef: string | undefined;
      for (const { item, batch } of deliverableItems) {
        const imageUrls = this.couponAssets?.imageUrls(batch) ?? batch.metadata?.imageUrls ?? [];
        const resolved = await resolveCouponDelivery({ ...batch, metadata: { ...(batch.metadata ?? {}), imageUrls } }, item, context, input.purpose);
        if (input.purpose !== 'delivery') await waitForDelay(resolved.delaySeconds);
        let imageIndex = 0;
        for (const imageUrl of resolved.imageUrls) {
          const file = await this.resolveImage(adminId, batch.id, imageUrl);
          const stepKey = `${item.itemId}:image:${imageIndex}`;
          const requestId = `automation:${input.executionKey}:${stepKey}`;
          if (input.purpose === 'delivery') {
            const result = await this.sendCheckedDeliveryStep({ adminId, accountId: input.accountId, orderNo: input.orderNo, executionKey: input.executionKey, stepKey }, () => im.sendImage(adminId, input.accountId, order.conversationId!, file, requestId, requestId));
            if (result.status !== 'succeeded') return result;
            sentAtLeastOne = true;
            externalMessageRef = result.externalRef ?? externalMessageRef;
          } else {
            const sent = await sendImageWithReconnectRetry(im, adminId, input.accountId, order.conversationId, file, requestId) as { externalMessageRef?: string };
            externalMessageRef = sent.externalMessageRef ?? externalMessageRef;
          }
          imageIndex += 1;
        }
        if (resolved.text) {
          let textIndex = 0;
          for (const message of splitMessages(resolved.text)) {
            const stepKey = `${item.itemId}:text:${textIndex}`;
            const requestId = `automation:${input.executionKey}:${stepKey}`;
            if (input.purpose === 'delivery') {
              const result = await this.sendCheckedDeliveryStep({ adminId, accountId: input.accountId, orderNo: input.orderNo, executionKey: input.executionKey, stepKey }, () => im.sendText(adminId, input.accountId, order.conversationId!, message, requestId, requestId));
              if (result.status !== 'succeeded') return result;
              sentAtLeastOne = true;
              externalMessageRef = result.externalRef ?? externalMessageRef;
            } else {
              const sent = await sendTextWithReconnectRetry(im, adminId, input.accountId, order.conversationId, message, requestId) as { externalMessageRef?: string };
              externalMessageRef = sent.externalMessageRef ?? externalMessageRef;
            }
            textIndex += 1;
          }
        }
      }
      if (!externalMessageRef) return sentAtLeastOne ? unknownExternal('COUPON_SEND_ACK_MISSING', 'message may have been sent without an acknowledgement') : failedExternal('COUPON_CONTENT_EMPTY', 'coupon reservation has no deliverable content');
      await this.recordAudit({ adminId, action: 'product.automation.coupon.sent', accountId: input.accountId, orderNo: input.orderNo, executionKey: input.executionKey, payload: { reservationId: reservation.reservationId, externalMessageRef } });
      return { status: 'succeeded', externalRef: externalMessageRef };
    } catch (error) {
      if (input.purpose === 'delivery' && sentAtLeastOne) {
        await this.store.quarantineCouponReservation({ adminId, executionKey: input.executionKey, reason: 'DELIVERY_PARTIAL_RESULT_UNKNOWN' });
        return unknownExternal('DELIVERY_PARTIAL_RESULT_UNKNOWN', error instanceof Error ? error.message : 'partial delivery outcome unknown');
      }
      return classifyExternalError(error, 'coupon_send');
    }
  }

  async commitCoupon(input: Parameters<AutomationExecutionPort['commitCoupon']>[0]): Promise<void> {
    const adminId = requireAdminId(input.adminId);
    const committed = await this.store.commitCouponReservation({ adminId, reservationId: input.reservationId, executionKey: input.executionKey });
    await this.recordAudit({ adminId, action: 'product.automation.coupon.committed', accountId: committed.accountId, executionKey: input.executionKey, payload: { reservationId: committed.reservationId, quantity: committed.quantity } });
  }

  async releaseCoupon(input: Parameters<AutomationExecutionPort['releaseCoupon']>[0]): Promise<void> {
    const adminId = requireAdminId(input.adminId);
    const released = await this.store.releaseCouponReservation({ adminId, reservationId: input.reservationId, executionKey: input.executionKey, reason: input.reason });
    await this.recordAudit({ adminId, action: 'product.automation.coupon.released', accountId: released.accountId, executionKey: input.executionKey, payload: { reservationId: released.reservationId, reason: input.reason, status: released.status } });
  }

  async confirmShipment(input: Parameters<AutomationExecutionPort['confirmShipment']>[0]): Promise<AutomationExternalResult> {
    const adminId = requireAdminId(input.adminId);
    if (!await this.loadScopedOrder(adminId, input.accountId, input.orderNo, input.productId, input.itemId)) return failedExternal('ORDER_SCOPE_MISMATCH', 'order or product scope does not match');
    const snapshot = await this.readOrder(input);
    if (!snapshot) return unknownExternal('AUTHORITATIVE_ORDER_UNAVAILABLE', 'order facts are incomplete');
    if (snapshot.deliveryStatus === 'delivered') return this.persistDeliveredOrder(adminId, input, input.orderNo);
    if (snapshot.paymentStatus !== 'paid' || snapshot.orderStatus !== 'open' || snapshot.afterSalesStatus !== 'none' || snapshot.deliveryStatus !== 'pending') return failedExternal('ORDER_NOT_DELIVERABLE', 'order is not eligible for shipment');
    const confirmation = await this.store.getDeliveryConfirmation({ adminId, accountId: input.accountId, orderNo: input.orderNo, executionKey: input.executionKey });
    if (!confirmation && input.executionKey.startsWith('paid_auto_delivery:')) return unknownExternal('DELIVERY_CONFIRMATION_SNAPSHOT_MISSING', 'delivery confirmation parameters require manual review');
    const step = { adminId, accountId: input.accountId, orderNo: input.orderNo, executionKey: input.executionKey, stepKey: 'shipment' };
    const claim = await this.store.beginDeliverySendStep(step);
    if (claim.status === 'blocked') return unknownExternal('SHIPMENT_RESULT_UNKNOWN', 'shipment requires manual reconciliation');
    if (claim.status === 'succeeded') return this.persistDeliveredOrder(adminId, input, claim.externalRef ?? input.orderNo);
    const noLogisticsForm = confirmation?.noLogisticsForm ?? input.noLogisticsForm;
    const tradeText = confirmation?.tradeText ?? input.tradeText;
    const result = await this.getMtop().confirmShipment(adminId, input.accountId, input.orderNo, noLogisticsForm ? tradeText ?? '' : '');
    const mapped = mapMutationResult(result);
    if (mapped.status === 'succeeded' || (mapped.status === 'failed' && isAlreadyDeliveredResult(mapped))) {
      const completed = await this.store.completeDeliverySendStep({ ...step, externalRef: mapped.externalRef ?? input.orderNo });
      if (!completed) return unknownExternal('SHIPMENT_CHECKPOINT_FAILED', 'shipment succeeded but checkpoint failed');
      return this.persistDeliveredOrder(adminId, input, mapped.externalRef ?? input.orderNo);
    }
    await this.store.markDeliverySendUnknown(step);
    return mapped;
  }

  private async persistDeliveredOrder(adminId: string, input: Parameters<AutomationExecutionPort['confirmShipment']>[0], externalRef: string): Promise<AutomationExternalResult> {
    try {
      const updated = await this.store.markOrderDelivered({ adminId, accountId: input.accountId, orderNo: input.orderNo });
      if (!updated) return unknownExternal('LOCAL_ORDER_STATUS_PERSIST_FAILED', 'remote shipment succeeded but local order was not found');
      await this.recordAudit({ adminId, action: 'product.automation.order.delivered', accountId: input.accountId, orderNo: input.orderNo, executionKey: input.executionKey, payload: { deliveryStatus: updated.deliveryStatus, externalRef } });
      return { status: 'succeeded', externalRef };
    } catch (error) {
      return unknownExternal('LOCAL_ORDER_STATUS_PERSIST_FAILED', `remote shipment succeeded but local order status persistence failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async repriceOrder(input: Parameters<AutomationExecutionPort['repriceOrder']>[0]): Promise<AutomationExternalResult> {
    const adminId = requireAdminId(input.adminId);
    if (!await this.loadScopedOrder(adminId, input.accountId, input.orderNo, input.productId, input.itemId)) return failedExternal('ORDER_SCOPE_MISMATCH', 'order or product scope does not match');
    const detail = await this.getMtop().readOrderDetail(adminId, input.accountId, input.orderNo);
    if (!detail.success || !detail.detail) {
      return unknownExternal(detail.errorCode ?? 'ORDER_DETAIL_UNAVAILABLE', detail.message ?? 'authoritative order detail is unavailable');
    }
    const paymentStatus = normalizePaymentStatus(detail.detail.paymentStatus, detail.detail.orderStatus);
    if (paymentStatus === 'paid') return failedExternal('ORDER_ALREADY_PAID', 'order is no longer unpaid');
    if (paymentStatus !== 'unpaid') return unknownExternal('ORDER_PAYMENT_STATUS_UNKNOWN', 'order payment status is not authoritative');
    if (detail.detail.amountMinor === input.targetPriceMinor) {
      return { status: 'succeeded', externalRef: input.orderNo };
    }
    const result = await this.getMtop().repriceOrder(adminId, input.accountId, input.orderNo, input.targetPriceMinor);
    return mapMutationResult(result);
  }

  async sendText(input: Parameters<AutomationExecutionPort['sendText']>[0]): Promise<AutomationExternalResult> {
    const adminId = requireAdminId(input.adminId);
    const im = this.getIm();
    if (!im) return unknownExternal('XIANYU_IM_NOT_READY', 'xianyu im service is not ready');
    if (typeof im.isReady === 'function' && !await im.isReady(adminId, input.accountId)) return failedExternal('XIANYU_IM_NOT_READY', 'xianyu im service is not ready before text send');
    try {
      const sent = await im.sendText(adminId, input.accountId, input.conversationId, input.text, `automation:${input.executionKey}`, `automation:${input.executionKey}`) as { externalMessageRef?: string };
      return { status: 'succeeded', externalRef: sent.externalMessageRef };
    } catch (error) {
      return classifyExternalError(error, 'text_send');
    }
  }

  async persistReviewFact(input: Parameters<AutomationExecutionPort['persistReviewFact']>[0]): Promise<{ created: boolean }> {
    const adminId = requireAdminId(input.adminId);
    const created = await this.store.recordReviewFact({ accountId: input.accountId, orderNo: input.orderNo, eventId: input.eventId });
    await this.recordAudit({ adminId, action: 'product.automation.review.fact_persisted', accountId: input.accountId, orderNo: input.orderNo, executionKey: input.executionKey, payload: { created: created.created } });
    return created;
  }

  async readOrder(input: Parameters<AutomationExecutionPort['readOrder']>[0]): Promise<AutomationOrderSnapshot | undefined> {
    const adminId = requireAdminId(input.adminId);
    const local = await this.store.getOrder(adminId, input.orderNo, input.accountId);
    if (!local) return undefined;
    const page = await this.getMtop().fetchOrderCandidates(adminId, input.accountId, input.orderNo);
    if (!page.success) return undefined;
    const matching = page.items.filter((item) => item.orderNo === input.orderNo);
    if (matching.length !== 1) return undefined;
    const listed = matching[0]!;
    if (listed.buyerId === 'unknown-buyer' || listed.itemId === 'unknown-item' || listed.buyerId !== local.buyerId || listed.itemId !== local.itemId) return undefined;
    const detail = await this.getMtop().readOrderDetail(adminId, input.accountId, input.orderNo);
    if (!detail.success || !detail.detail) return undefined;
    const detailPayment = normalizePaymentStatus(detail.detail.paymentStatus, detail.detail.orderStatus);
    const detailDelivery = normalizeDeliveryStatus(detail.detail.deliveryStatus);
    const detailOrder = normalizeDetailOrderStatus(detail.detail.orderStatus);
    if (!detailPayment || !detailDelivery || (detail.detail.orderStatus && !detailOrder)
      || (detailOrder && detailOrder !== listed.orderStatus)
      || detailPayment !== listed.paymentStatus || detailDelivery !== listed.deliveryStatus) return undefined;
    if (detail.detail.buyerId && detail.detail.buyerId !== listed.buyerId) return undefined;
    if (detail.detail.itemId && detail.detail.itemId !== listed.itemId) return undefined;
    return { ...mergeOrderSnapshot(local, detail.detail), paymentStatus: listed.paymentStatus, orderStatus: listed.orderStatus, deliveryStatus: listed.deliveryStatus, afterSalesStatus: listed.afterSalesStatus, buyerId: listed.buyerId, itemId: listed.itemId, updatedAt: new Date().toISOString() };
  }

  async markManualReview(input: Parameters<AutomationExecutionPort['markManualReview']>[0]): Promise<void> {
    const adminId = requireAdminId(input.adminId);
    await this.store.quarantineCouponReservation({ adminId, executionKey: input.executionKey, reason: input.reason });
    await this.recordAudit({ adminId, action: 'product.automation.manual_review', accountId: input.accountId, orderNo: input.orderNo, executionKey: input.executionKey, payload: { reason: input.reason, productId: input.productId, itemId: input.itemId } });
  }

  private async sendCheckedDeliveryStep(input: { adminId: string; accountId: string; orderNo: string; executionKey: string; stepKey: string }, send: () => Promise<unknown>): Promise<AutomationExternalResult> {
    const claim = await this.store.beginDeliverySendStep(input);
    if (claim.status === 'succeeded') return { status: 'succeeded', externalRef: claim.externalRef };
    if (claim.status === 'blocked') {
      await this.store.quarantineCouponReservation({ adminId: input.adminId, executionKey: input.executionKey, reason: 'DELIVERY_SEND_RESULT_UNKNOWN' });
      return unknownExternal('DELIVERY_SEND_RESULT_UNKNOWN', 'delivery send requires manual reconciliation');
    }
    try {
      const sent = await send() as { externalMessageRef?: string };
      const completed = await this.store.completeDeliverySendStep({ ...input, externalRef: sent.externalMessageRef });
      if (!completed) throw new Error('DELIVERY_SEND_CHECKPOINT_FAILED');
      return { status: 'succeeded', externalRef: sent.externalMessageRef };
    } catch (error) {
      try { await this.store.markDeliverySendUnknown(input); } catch { /* a persisted sending step still blocks replay */ }
      await this.store.quarantineCouponReservation({ adminId: input.adminId, executionKey: input.executionKey, reason: 'DELIVERY_SEND_RESULT_UNKNOWN' });
      return unknownExternal('DELIVERY_SEND_RESULT_UNKNOWN', error instanceof Error ? error.message : 'delivery send outcome unknown');
    }
  }

  private async loadScopedOrder(adminId: string, accountId: string, orderNo: string, productId?: string, itemId?: string): Promise<AutomationOrderSnapshot | undefined> {
    const order = await this.store.getOrder(adminId, orderNo, accountId);
    if (!order || order.accountId !== accountId) return undefined;
    if (productId && order.productId !== productId) return undefined;
    if (itemId && order.itemId !== itemId) return undefined;
    if (!order.productId) return undefined;
    const product = await this.store.getProduct(adminId, order.productId);
    if (!product || product.accountId !== accountId) return undefined;
    if (product.externalProductRef && product.externalProductRef !== order.itemId) return undefined;
    return order;
  }

  private async resolveImage(adminId: string, batchId: string, imageUrl: string): Promise<{ filename: string; contentType: string; data: Buffer }> {
    const assetMatch = imageUrl.match(/\/api\/v1\/coupons\/batches\/[^/]+\/assets\/([^/?#]+)/u);
    if (assetMatch && this.couponAssets) {
      const asset = await this.couponAssets.getAsset({ adminId, batchId, assetId: decodeURIComponent(assetMatch[1]) });
      if (asset) return { filename: asset.asset.storageKey.split('/').pop() ?? 'coupon-image', contentType: asset.object.contentType, data: asset.object.body };
    }
    const dataUrl = imageUrl.match(/^data:(image\/[^;]+);base64,(.+)$/u);
    if (dataUrl) return { filename: 'coupon-image', contentType: dataUrl[1], data: Buffer.from(dataUrl[2], 'base64') };
    const response = await fetch(imageUrl, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`COUPON_IMAGE_HTTP_${response.status}`);
    const contentType = response.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
    return { filename: imageUrl.split('/').pop()?.split('?')[0] || 'coupon-image', contentType, data: Buffer.from(await response.arrayBuffer()) };
  }

  private async recordAudit(input: { adminId: string; action: string; accountId?: string; orderNo?: string; executionKey?: string; payload?: unknown }): Promise<void> {
    try { await this.audit?.(input); } catch { /* audit failure must not duplicate an external mutation */ }
  }
}

function mergeOrderSnapshot(local: AutomationOrderSnapshot, detail: XianyuOrderDetailSummary): AutomationOrderSnapshot {
  return {
    ...local,
    quantity: detail.quantity ?? local.quantity,
    skuSpec: detail.skuSpec ?? local.skuSpec,
    amountMinor: detail.amountMinor ?? local.amountMinor,
    itemId: detail.itemId ?? local.itemId,
    itemTitle: detail.itemTitle ?? local.itemTitle,
    conversationId: detail.conversationId ?? local.conversationId,
    buyerId: detail.buyerId ?? local.buyerId,
    paymentStatus: normalizePaymentStatus(detail.paymentStatus, detail.orderStatus) ?? local.paymentStatus,
    deliveryStatus: normalizeDeliveryStatus(detail.deliveryStatus) ?? local.deliveryStatus,
    reviewedAt: detail.reviewedAt ?? local.reviewedAt,
    updatedAt: new Date().toISOString(),
  };
}

function normalizePaymentStatus(value?: string, orderStatus?: string): AutomationOrderSnapshot['paymentStatus'] | undefined {
  const candidates = [value, orderStatus]
    .map((candidate) => candidate?.trim().toLowerCase())
    .filter((candidate): candidate is string => Boolean(candidate));
  for (const normalized of candidates) {
    if (['2', '3', '4', 'paid', 'success', 'pay_success', 'trade_success', 'wait_consign', 'shipped', 'completed', '已付款', '待发货', '已发货', '交易成功', '已完成'].includes(normalized)) return 'paid';
    if (['1', 'unpaid', 'wait_buyer_pay', 'wait_pay', 'pending', 'processing', '待付款', '未付款', '处理中'].includes(normalized)) return 'unpaid';
  }
  return undefined;
}

function normalizeDeliveryStatus(value?: string): AutomationOrderSnapshot['deliveryStatus'] | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  // Xianyu order detail uses numeric status codes: 2 = pending shipment,
  // 3 = shipped, and 4 = completed. Treat both shipped and completed as
  // delivered for idempotent confirmation checks.
  if (['3', '4', 'delivered', 'consigned', 'shipped', '已发货', '交易成功'].includes(normalized)) return 'delivered';
  if (['1', '2', 'pending', 'wait_consign', 'not_delivered', '待发货', '未发货'].includes(normalized)) return 'pending';
  return undefined;
}

function normalizeDetailOrderStatus(value?: string): AutomationOrderSnapshot['orderStatus'] | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (/canceling|cancelling|取消中/u.test(normalized)) return 'cancelling';
  if (/cancelled|canceled|已取消|退款成功|已退款|退款关闭/u.test(normalized)) return 'cancelled';
  if (normalized === '4' || /complete|finished|success|已完成|交易成功/u.test(normalized)) return 'completed';
  if (/closed|关闭|交易关闭/u.test(normalized)) return 'closed';
  if (/fail|失败/u.test(normalized)) return 'failed';
  if (['1', '2', '3', 'open', 'wait_buyer_pay', 'wait_pay', 'wait_consign', 'shipped', '待付款', '待发货', '已发货'].includes(normalized)) return 'open';
  return undefined;
}

function isDelivered(detail: XianyuOrderDetailSummary): boolean {
  return normalizeDeliveryStatus(detail.deliveryStatus) === 'delivered';
}

function selectBatchesForSpec(batches: Array<NonNullable<Awaited<ReturnType<Store['getCouponBatch']>>>>, skuSpec?: string) {
  const multiSpec = batches.filter((batch) => batch.metadata?.multiSpec === true);
  if (multiSpec.length === 0) return batches;
  const parsed = parseSkuSpec(skuSpec);
  if (!parsed.specName || !parsed.specValue) throw new Error('COUPON_SPEC_MISMATCH');
  return multiSpec.filter((batch) => batch.metadata?.specName === parsed.specName && batch.metadata?.specValue === parsed.specValue);
}

async function waitForDelay(seconds: number): Promise<void> {
  const milliseconds = Math.max(0, Math.min(3_600_000, Math.trunc(Number(seconds) * 1000 || 0)));
  if (milliseconds > 0) await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function splitMessages(value: string): string[] {
  return value.split('######').map((message) => message.trim()).filter(Boolean);
}

async function sendTextWithReconnectRetry(im: XianyuImService, adminId: string, accountId: string, conversationId: string, text: string, requestId: string): Promise<unknown> {
  return sendWithReconnectRetry(async () => im.sendText(adminId, accountId, conversationId, text, requestId, requestId), im, adminId, accountId);
}

async function sendImageWithReconnectRetry(im: XianyuImService, adminId: string, accountId: string, conversationId: string, file: { filename: string; contentType: string; data: Buffer }, requestId: string): Promise<unknown> {
  return sendWithReconnectRetry(async () => im.sendImage(adminId, accountId, conversationId, file, requestId, requestId), im, adminId, accountId);
}

async function sendWithReconnectRetry(send: () => Promise<unknown>, im: XianyuImService, adminId: string, accountId: string): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      lastError = error;
      if (!isRetryableImConnectionError(error) || typeof im.resetClient !== 'function' || attempt === 1) throw error;
      await im.resetClient(adminId, accountId);
    }
  }
  throw lastError;
}

function isRetryableImConnectionError(error: unknown): boolean {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message.toUpperCase() : String(error).toUpperCase();
  return /(?:XIANYU_IM_CONNECTION_CLOSED|XIANYU_IM_NOT_CONNECTED|XIANYU_IM_WS_OPEN_TIMEOUT|ECONNRESET|ETIMEDOUT|TIMEOUT|FAILED_TO_FETCH)/u.test(code)
    || /FAILED TO FETCH|FETCH FAILED/u.test(message);
}

function mapMutationResult(result: XianyuExternalMutationResult): AutomationExternalResult {
  return { status: result.status, externalRef: result.externalRef, errorCode: result.errorCode, message: result.message };
}

function classifyExternalError(error: unknown, prefix: string): AutomationExternalResult {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message.slice(0, 180) : String(error).slice(0, 180);
  const knownFailure = /INVALID|MISSING|NOT_FOUND|FORBIDDEN|SCOPE|SESSION_EXPIRED|ACCOUNT|AUTH|PERMISSION|REJECTED_4\d\d|REMOTE_4\d\d|COUPON_CONTENT_EMPTY/u.test(code);
  const retryable = !knownFailure && isRetryableImConnectionError(error);
  return { status: knownFailure ? 'failed' : 'unknown', errorCode: code || `${prefix.toUpperCase()}_UNKNOWN`, message, retryable };
}

function failedExternal(errorCode: string, message: string): AutomationExternalResult {
  return { status: 'failed', errorCode, message };
}

function unknownExternal(errorCode: string, message: string): AutomationExternalResult {
  return { status: 'unknown', errorCode, message };
}

function retryableUnknownExternal(errorCode: string, message: string): AutomationExternalResult {
  return { status: 'unknown', errorCode, message, retryable: true };
}

function isAlreadyDeliveredResult(result: AutomationExternalResult): boolean {
  return result.errorCode === 'ORDER_ALREADY_DELIVERY'
    || result.message?.includes('ORDER_ALREADY_DELIVERY') === true;
}

function requireAdminId(value: string | undefined): string {
  const adminId = value?.trim();
  if (!adminId) throw new Error('ADMIN_ID_REQUIRED');
  return adminId;
}

function errorCode(error: unknown): string {
  const candidate = (error as { code?: unknown } | undefined)?.code;
  if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().toUpperCase();
  if (typeof candidate === 'number' && Number.isFinite(candidate)) return `REMOTE_${candidate}`;
  return error instanceof Error ? error.message.replace(/\s+/gu, '_').slice(0, 80).toUpperCase() : 'EXTERNAL_EXECUTION_FAILED';
}
