import { Button } from '../../../shared/ui/Button';
import { InputField } from '../../../shared/ui/InputField';
import { SelectField } from '../../../shared/ui/SelectField';
import { TextAreaField } from '../../../shared/ui/TextAreaField';
import type { AutoReplyPolicyVM, AutoReplyBlacklistEntryVM, AutoReplyMessageFilterVM } from '../types';

const matchModeOptions = [
  { value: 'contains', label: '包含关键词' },
  { value: 'exact', label: '整句相同' },
  { value: 'regex', label: '正则表达式' },
] as const;

export const EMPTY_REPLY_POLICY_VM: AutoReplyPolicyVM = {
  messageFilters: [],
  blacklist: [],
  defaultReply: { enabled: false, content: '', replyOnce: true },
  autoRate: { enabled: false, content: '好买家，交易愉快！' },
};

function newFilter(index: number): AutoReplyMessageFilterVM {
  return { id: `mf-${Date.now()}-${index}`, keyword: '', matchMode: 'contains', skipReply: true, skipNotify: false, enabled: true };
}
function newBlacklistEntry(index: number): AutoReplyBlacklistEntryVM {
  return { id: `bl-${Date.now()}-${index}`, buyerRef: '', buyerName: '', itemRef: '', reason: '', enabled: true };
}

export function ReplyPolicyEditor({ policy, disabled = false, onChange }: { policy: AutoReplyPolicyVM; disabled?: boolean; onChange: (policy: AutoReplyPolicyVM) => void }) {
  const filters = policy.messageFilters ?? [];
  const blacklist = policy.blacklist ?? [];
  const setFilters = (next: AutoReplyMessageFilterVM[]) => onChange({ ...policy, messageFilters: next });
  const setBlacklist = (next: AutoReplyBlacklistEntryVM[]) => onChange({ ...policy, blacklist: next });

  return <>
    <section className="keyword-rules reply-policy" data-reply-policy-filters aria-label="消息过滤">
      <div className="keyword-rules-head">
        <div><h3>消息过滤</h3><p>命中关键词的买家消息可以跳过自动回复、或者不再推送"需要人工"通知。适合挡掉系统提示、广告和同行探店。</p></div>
        <Button variant="ghost" type="button" disabled={disabled} data-testid="message-filter-add" onClick={() => setFilters([...filters, newFilter(filters.length + 1)])}>添加过滤规则</Button>
      </div>
      {filters.length === 0 && <p className="keyword-rules-empty">还没有过滤规则。例如：「加微信」→ 跳过回复；「拼单」→ 不通知。</p>}
      {filters.map((filter, index) => (
        <fieldset className="keyword-rule" key={filter.id} disabled={disabled} data-testid="message-filter">
          <div className="keyword-rule-grid">
            <InputField label="关键词" value={filter.keyword} placeholder="关键词或正则" onChange={(event) => setFilters(filters.map((item, position) => position === index ? { ...item, keyword: event.target.value } : item))} />
            <SelectField label="匹配方式" value={filter.matchMode} options={matchModeOptions} onChange={(event) => setFilters(filters.map((item, position) => position === index ? { ...item, matchMode: event.target.value as AutoReplyMessageFilterVM['matchMode'] } : item))} />
          </div>
          <div className="reply-policy-toggles">
            <label className="reply-policy-toggle"><input type="checkbox" checked={filter.skipReply} onChange={(event) => setFilters(filters.map((item, position) => position === index ? { ...item, skipReply: event.target.checked } : item))} /> 跳过自动回复</label>
            <label className="reply-policy-toggle"><input type="checkbox" checked={filter.skipNotify} onChange={(event) => setFilters(filters.map((item, position) => position === index ? { ...item, skipNotify: event.target.checked } : item))} /> 不推送人工通知</label>
            <label className="reply-policy-toggle"><input type="checkbox" checked={filter.enabled} onChange={(event) => setFilters(filters.map((item, position) => position === index ? { ...item, enabled: event.target.checked } : item))} /> 启用</label>
            <Button variant="ghost" size="small" type="button" onClick={() => setFilters(filters.filter((_, position) => position !== index))}>删除</Button>
          </div>
        </fieldset>
      ))}
    </section>

    <section className="keyword-rules reply-policy" data-reply-policy-blacklist aria-label="买家黑名单">
      <div className="keyword-rules-head">
        <div><h3>买家黑名单</h3><p>黑名单里的买家不会收到自动回复，也不会触发人工通知。买家 ID 可以在聊天页会话信息里看到；填了商品 ID 就只对该商品生效。</p></div>
        <Button variant="ghost" type="button" disabled={disabled} data-testid="blacklist-add" onClick={() => setBlacklist([...blacklist, newBlacklistEntry(blacklist.length + 1)])}>添加黑名单</Button>
      </div>
      {blacklist.length === 0 && <p className="keyword-rules-empty">还没有黑名单。</p>}
      {blacklist.map((entry, index) => (
        <fieldset className="keyword-rule" key={entry.id} disabled={disabled} data-testid="blacklist-entry">
          <div className="keyword-rule-grid reply-policy-grid-4">
            <InputField label="买家 ID" value={entry.buyerRef} placeholder="例如 2650748284" onChange={(event) => setBlacklist(blacklist.map((item, position) => position === index ? { ...item, buyerRef: event.target.value } : item))} />
            <InputField label="备注昵称" value={entry.buyerName ?? ''} placeholder="可选" onChange={(event) => setBlacklist(blacklist.map((item, position) => position === index ? { ...item, buyerName: event.target.value } : item))} />
            <InputField label="仅限商品 ID" value={entry.itemRef ?? ''} placeholder="留空则全部商品" onChange={(event) => setBlacklist(blacklist.map((item, position) => position === index ? { ...item, itemRef: event.target.value } : item))} />
            <InputField label="原因" value={entry.reason ?? ''} placeholder="可选" onChange={(event) => setBlacklist(blacklist.map((item, position) => position === index ? { ...item, reason: event.target.value } : item))} />
          </div>
          <div className="reply-policy-toggles">
            <label className="reply-policy-toggle"><input type="checkbox" checked={entry.enabled} onChange={(event) => setBlacklist(blacklist.map((item, position) => position === index ? { ...item, enabled: event.target.checked } : item))} /> 启用</label>
            <Button variant="ghost" size="small" type="button" onClick={() => setBlacklist(blacklist.filter((_, position) => position !== index))}>删除</Button>
          </div>
        </fieldset>
      ))}
    </section>

    <section className="keyword-rules reply-policy" data-reply-policy-default aria-label="默认回复">
      <div className="keyword-rules-head">
        <div><h3>默认回复</h3><p>模型没有生成回复、判断为跳过或调用失败时，发送这段固定文案作为兜底。</p></div>
        <label className="reply-policy-toggle"><input type="checkbox" disabled={disabled} checked={policy.defaultReply.enabled} onChange={(event) => onChange({ ...policy, defaultReply: { ...policy.defaultReply, enabled: event.target.checked } })} /> 启用</label>
      </div>
      <TextAreaField label="回复内容" rows={3} disabled={disabled} value={policy.defaultReply.content} placeholder="例如：您好，在的～看到消息会尽快回复您，拍下后系统自动发货。" onChange={(event) => onChange({ ...policy, defaultReply: { ...policy.defaultReply, content: event.target.value } })} />
      <label className="reply-policy-toggle"><input type="checkbox" disabled={disabled} checked={policy.defaultReply.replyOnce} onChange={(event) => onChange({ ...policy, defaultReply: { ...policy.defaultReply, replyOnce: event.target.checked } })} /> 每个会话只发一次</label>
    </section>

    <section className="keyword-rules reply-policy" data-reply-policy-rate aria-label="自动好评">
      <div className="keyword-rules-head">
        <div><h3>自动好评</h3><p>买家确认收货、交易成功后自动给买家一个好评。</p></div>
        <label className="reply-policy-toggle"><input type="checkbox" disabled={disabled} checked={policy.autoRate.enabled} onChange={(event) => onChange({ ...policy, autoRate: { ...policy.autoRate, enabled: event.target.checked } })} /> 启用</label>
      </div>
      <InputField label="评价内容" disabled={disabled} value={policy.autoRate.content} placeholder="好买家，交易愉快！" onChange={(event) => onChange({ ...policy, autoRate: { ...policy.autoRate, content: event.target.value } })} />
    </section>
  </>;
}
