import type { XianyuImMessageEvent } from './xianyu-im.js';
import { parseXianyuSystemMessageKind } from './xianyu-system-message.js';

const ORDER_KEYS = new Set(['orderid', 'orderno', 'bizorderid', 'tradeid']);

export function isTrustedPaidEvent(event: XianyuImMessageEvent): boolean {
  return event.direction === 'inbound'
    && event.platformSystemMessage === true
    && parseXianyuSystemMessageKind(event.bodyText) === 'paid_waiting_shipment';
}

export function trustedPaymentOccurredAt(event: XianyuImMessageEvent, now = Date.now()): string {
  const valid = (value: string | undefined): string | undefined => {
    if (!value) return undefined;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && timestamp >= Date.UTC(2020, 0, 1) && timestamp <= now + 120_000 ? new Date(timestamp).toISOString() : undefined;
  };
  if (!event.riskFlags?.includes('source_timestamp_invalid')) {
    const occurredAt = valid(event.occurredAt);
    if (occurredAt) return occurredAt;
  }
  return valid(event.receivedAt) ?? new Date(now).toISOString();
}

export function extractTrustedOrderNo(raw: Record<string, unknown> | undefined): string | undefined {
  if (!raw) return undefined;
  const found = new Set<string>();
  const queue: Array<{ value: unknown; depth: number }> = [{ value: raw, depth: 0 }];
  let scanned = 0;
  while (queue.length && scanned < 256) {
    const { value, depth } = queue.shift()!;
    scanned += 1;
    if (depth > 9) continue;
    if (Array.isArray(value)) {
      for (const child of value.slice(0, 32)) queue.push({ value: child, depth: depth + 1 });
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, '');
      if (ORDER_KEYS.has(normalizedKey)) addOrderNo(found, child);
      if (key === 'targetUrl' && typeof child === 'string') {
        const query = child.split('?', 2)[1];
        if (query) {
          const params = new URLSearchParams(query);
          for (const name of ['orderId', 'bizOrderId', 'orderNo']) addOrderNo(found, params.get(name));
          if (/order_detail/i.test(child)) addOrderNo(found, params.get('id'));
        }
      }
      if (typeof child === 'string' && child.length <= 32_768 && child.trimStart().startsWith('{')) {
        try { queue.push({ value: JSON.parse(child), depth: depth + 1 }); } catch { /* opaque text */ }
      } else if (child && typeof child === 'object') queue.push({ value: child, depth: depth + 1 });
    }
  }
  return found.size === 1 ? [...found][0] : undefined;
}

function addOrderNo(found: Set<string>, value: unknown): void {
  const candidate = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (/^\d{10,24}$/.test(candidate)) found.add(candidate);
}
