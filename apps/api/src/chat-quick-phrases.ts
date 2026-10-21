import type { ChatQuickPhrase } from './domain.js';
import { ServiceError } from './services.js';

export const MAX_QUICK_PHRASES = 50;
export const MAX_QUICK_PHRASE_LABEL = 20;
export const MAX_QUICK_PHRASE_CONTENT = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function defaultLabel(content: string): string {
  const firstLine = content.split('\n')[0]?.trim() ?? '';
  return firstLine.length > MAX_QUICK_PHRASE_LABEL ? `${firstLine.slice(0, MAX_QUICK_PHRASE_LABEL - 1)}…` : firstLine;
}

/** Tolerant reader for stored config: drops junk instead of failing the whole config. */
export function sanitizeQuickPhrases(raw: unknown): ChatQuickPhrase[] {
  if (!Array.isArray(raw)) return [];
  const result: ChatQuickPhrase[] = [];
  for (const [index, item] of raw.entries()) {
    if (!isRecord(item)) continue;
    const content = typeof item.content === 'string' ? item.content.trim().slice(0, MAX_QUICK_PHRASE_CONTENT) : '';
    if (!content) continue;
    const label = typeof item.label === 'string' && item.label.trim() ? item.label.trim().slice(0, MAX_QUICK_PHRASE_LABEL) : defaultLabel(content);
    const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim().slice(0, 64) : `qp-${index + 1}`;
    result.push({ id, label, content });
    if (result.length >= MAX_QUICK_PHRASES) break;
  }
  return result;
}

/** Strict reader for operator input: explains what is wrong instead of silently dropping it. */
export function validateQuickPhrases(raw: unknown): ChatQuickPhrase[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ServiceError(422, 'VALIDATION_FAILED', 'quickPhrases must be an array');
  if (raw.length > MAX_QUICK_PHRASES) throw new ServiceError(422, 'VALIDATION_FAILED', `快捷短语最多 ${MAX_QUICK_PHRASES} 条`);
  const seen = new Set<string>();
  return raw.map((item, index) => {
    if (!isRecord(item)) throw new ServiceError(422, 'VALIDATION_FAILED', `第 ${index + 1} 条快捷短语格式不正确`);
    const content = typeof item.content === 'string' ? item.content.trim() : '';
    if (!content) throw new ServiceError(422, 'VALIDATION_FAILED', `第 ${index + 1} 条快捷短语内容不能为空`);
    if (content.length > MAX_QUICK_PHRASE_CONTENT) throw new ServiceError(422, 'VALIDATION_FAILED', `第 ${index + 1} 条快捷短语超过 ${MAX_QUICK_PHRASE_CONTENT} 字`);
    const label = typeof item.label === 'string' && item.label.trim() ? item.label.trim() : defaultLabel(content);
    if (label.length > MAX_QUICK_PHRASE_LABEL) throw new ServiceError(422, 'VALIDATION_FAILED', `第 ${index + 1} 条快捷短语的名称超过 ${MAX_QUICK_PHRASE_LABEL} 字`);
    let id = typeof item.id === 'string' && item.id.trim() ? item.id.trim().slice(0, 64) : `qp-${Date.now().toString(36)}-${index + 1}`;
    while (seen.has(id)) id = `${id}-${index + 1}`;
    seen.add(id);
    return { id, label, content };
  });
}
