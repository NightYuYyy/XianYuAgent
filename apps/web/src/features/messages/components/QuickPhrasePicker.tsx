import { Button } from '../../../shared/ui/Button';
import { InputField } from '../../../shared/ui/InputField';
import { TextAreaField } from '../../../shared/ui/TextAreaField';
import type { QuickPhraseVM } from '../types';

export interface QuickPhraseDraft {
  label: string;
  content: string;
}

/** Popover under the composer tools: insert a canned phrase, or manage the list in place. */
export function QuickPhrasePicker({ phrases, manage, busy, error, draft, onToggleManage, onInsert, onRemove, onDraftChange, onAdd }: {
  phrases: QuickPhraseVM[];
  manage: boolean;
  busy: boolean;
  error: string;
  draft: QuickPhraseDraft;
  onToggleManage: () => void;
  onInsert: (content: string) => void;
  onRemove: (id: string) => void;
  onDraftChange: (draft: QuickPhraseDraft) => void;
  onAdd: () => void;
}) {
  return <div className="messages-phrase-picker" role="dialog" aria-label="快捷短语">
    <div className="messages-phrase-head"><strong>快捷短语</strong><button type="button" className="messages-phrase-link" onClick={onToggleManage}>{manage ? '完成' : '管理'}</button></div>
    {phrases.length === 0 && !manage && <p className="messages-phrase-empty">还没有快捷短语，点「管理」添加常用话术。</p>}
    <div className="messages-phrase-list">{phrases.map((phrase) => <div className="messages-phrase-item" key={phrase.id}>
      <button type="button" className="messages-phrase-insert" title={phrase.content} onClick={() => onInsert(phrase.content)}><strong>{phrase.label}</strong><span>{phrase.content}</span></button>
      {manage && <button type="button" className="messages-phrase-remove" aria-label={`删除 ${phrase.label}`} disabled={busy} onClick={() => onRemove(phrase.id)}>×</button>}
    </div>)}</div>
    {manage && <div className="messages-phrase-form">
      <InputField label="名称" value={draft.label} placeholder="按钮上显示的短名字，可留空" onChange={(event) => onDraftChange({ ...draft, label: event.target.value })} />
      <TextAreaField label="内容" rows={3} value={draft.content} placeholder="点一下就插入到输入框的完整话术" onChange={(event) => onDraftChange({ ...draft, content: event.target.value })} />
      <div className="messages-phrase-form-actions"><Button variant="primary" size="small" type="button" disabled={busy || !draft.content.trim()} onClick={onAdd}>{busy ? '保存中…' : '添加'}</Button></div>
    </div>}
    {error && <p className="messages-phrase-error" role="alert">{error}</p>}
  </div>;
}
