import { Button } from '../../../shared/ui/Button';
import { InputField } from '../../../shared/ui/InputField';
import { SelectField } from '../../../shared/ui/SelectField';
import { TextAreaField } from '../../../shared/ui/TextAreaField';
import type { AutoReplyKeywordRuleVM } from '../types';

const matchModeOptions = [
  { value: 'contains', label: '包含关键词' },
  { value: 'exact', label: '整句相同' },
  { value: 'regex', label: '正则表达式' },
] as const;

export function createEmptyKeywordRule(index: number): AutoReplyKeywordRuleVM {
  return { id: `kw-${Date.now()}-${index}`, keywords: [], reply: '', matchMode: 'contains', enabled: true };
}

export function KeywordRulesEditor({ rules, disabled = false, onChange }: { rules: AutoReplyKeywordRuleVM[]; disabled?: boolean; onChange: (rules: AutoReplyKeywordRuleVM[]) => void }) {
  function update(index: number, patch: Partial<AutoReplyKeywordRuleVM>) {
    onChange(rules.map((rule, position) => position === index ? { ...rule, ...patch } : rule));
  }

  return <section className="keyword-rules" data-keyword-rules aria-label="关键词快速回复">
    <div className="keyword-rules-head">
      <div><h3>关键词快速回复</h3><p>买家消息命中规则时直接按模板回复，不经过模型；没命中才交给自动回复 Agent。规则按从上到下的顺序匹配，第一条命中的生效。</p></div>
      <Button variant="ghost" type="button" disabled={disabled} data-testid="keyword-rule-add" onClick={() => onChange([...rules, createEmptyKeywordRule(rules.length + 1)])}>添加规则</Button>
    </div>
    {rules.length === 0 && <p className="keyword-rules-empty">还没有规则。常见用法：「发货了吗」→ 说明自动发货；「怎么用」→ 使用教程链接；「能便宜吗」→ 固定话术。</p>}
    {rules.map((rule, index) => (
      <fieldset className="keyword-rule" key={rule.id} disabled={disabled} data-testid="keyword-rule">
        <div className="keyword-rule-grid">
          <InputField
            label="关键词（逗号分隔，任一命中）"
            fieldClassName="full"
            value={rule.keywords.join(', ')}
            placeholder="发货了吗, 什么时候发货"
            onChange={(event) => update(index, { keywords: event.target.value.split(/[,，\n]/u).map((item) => item.trim()).filter(Boolean) })}
            required
          />
          <TextAreaField
            label="回复内容"
            fieldClassName="full"
            rows={2}
            maxLength={2000}
            value={rule.reply}
            placeholder="拍下后系统自动发货，请查看聊天记录里的卡密。"
            onChange={(event) => update(index, { reply: event.target.value })}
            required
          />
          <SelectField label="匹配方式" value={rule.matchMode} options={matchModeOptions} onChange={(event) => update(index, { matchMode: event.target.value as AutoReplyKeywordRuleVM['matchMode'] })} />
          <InputField label="仅限商品 ID（可选）" value={rule.productRef ?? ''} placeholder="留空对所有商品生效" onChange={(event) => update(index, { productRef: event.target.value.trim() || undefined })} />
          <label className="settings-checkbox"><input type="checkbox" checked={rule.enabled} onChange={(event) => update(index, { enabled: event.target.checked })} />启用</label>
          <div className="keyword-rule-actions">
            <Button variant="ghost" type="button" disabled={index === 0} onClick={() => { const next = [...rules]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; onChange(next); }}>上移</Button>
            <Button variant="danger" type="button" data-testid="keyword-rule-remove" onClick={() => onChange(rules.filter((_, position) => position !== index))}>删除</Button>
          </div>
        </div>
      </fieldset>
    ))}
  </section>;
}
