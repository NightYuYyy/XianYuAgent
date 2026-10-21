import { Button } from '../../../shared/ui/Button';
import { InputField } from '../../../shared/ui/InputField';
import { TextAreaField } from '../../../shared/ui/TextAreaField';
import type { ChatQuickPhraseVM } from '../types';

export function newQuickPhrase(index: number): ChatQuickPhraseVM {
  return { id: `qp-${Date.now().toString(36)}-${index}`, label: '', content: '' };
}

export function QuickPhrasesEditor({ phrases, onChange }: { phrases: ChatQuickPhraseVM[]; onChange: (next: ChatQuickPhraseVM[]) => void }) {
  return <section className="keyword-rules quick-phrases" data-quick-phrases aria-label="快捷短语">
    <div className="keyword-rules-head">
      <div><h3>聊天快捷短语</h3><p>在线聊天输入框旁的「短语」按钮里显示，点一下就插入到输入框。这是给你手动回复用的，和自动回复无关；在聊天页也能直接增删。</p></div>
      <Button variant="ghost" type="button" data-testid="quick-phrase-add" onClick={() => onChange([...phrases, newQuickPhrase(phrases.length + 1)])}>添加短语</Button>
    </div>
    {phrases.length === 0 && <p className="keyword-rules-empty">还没有快捷短语。例如：「发货说明」→ 拍下后系统自动发货，请注意查收。</p>}
    {phrases.map((phrase, index) => <fieldset className="keyword-rule" key={phrase.id} data-testid="quick-phrase">
      <div className="keyword-rule-grid">
        <InputField label="名称" value={phrase.label} placeholder="按钮上显示的短名字，留空取内容开头" onChange={(event) => onChange(phrases.map((item, position) => position === index ? { ...item, label: event.target.value } : item))} />
        <TextAreaField label="内容" rows={2} value={phrase.content} placeholder="插入到输入框的完整话术" onChange={(event) => onChange(phrases.map((item, position) => position === index ? { ...item, content: event.target.value } : item))} />
      </div>
      <div className="reply-policy-toggles"><Button variant="ghost" size="small" type="button" onClick={() => onChange(phrases.filter((_, position) => position !== index))}>删除</Button></div>
    </fieldset>)}
  </section>;
}
