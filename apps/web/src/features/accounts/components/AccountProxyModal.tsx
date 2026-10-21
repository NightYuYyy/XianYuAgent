import { useState } from 'react';
import { InputField } from '../../../shared/ui/InputField';
import type { AccountVM } from '../types';

const PROXY_PATTERN = /^https?:\/\/(?:[^@/\s]+@)?[^/\s:]+(?::\d{1,5})?\/?$/i;

export function isValidProxyUrl(value: string): boolean {
  return PROXY_PATTERN.test(value.trim());
}

export function AccountProxyModal({ account, submitting = false, onClose, onSave }: {
  account: AccountVM;
  submitting?: boolean;
  onClose: () => void;
  /** `null` clears the proxy and the account goes back to the default / direct connection. */
  onSave: (proxyUrl: string | null) => void;
}) {
  const [value, setValue] = useState(account.proxyUrl ?? '');
  const trimmed = value.trim();
  const valid = trimmed === '' || isValidProxyUrl(trimmed);

  return <div className="modal-backdrop account-modal-backdrop" role="presentation" onMouseDown={(event) => { if (!submitting && event.target === event.currentTarget) onClose(); }}>
    <section className="modal-card account-proxy-modal" role="dialog" aria-modal="true" aria-labelledby="account-proxy-title" aria-describedby="account-proxy-description">
      <header className="modal-head">
        <div><p className="eyebrow">Account Network</p><h2 id="account-proxy-title">账号出站代理</h2><p id="account-proxy-description">{account.displayName} 的闲鱼请求（接口、消息、扫码、验证浏览器）将全部经此代理出站。</p></div>
        <button className="icon-button" type="button" aria-label="关闭代理设置弹窗" onClick={onClose} disabled={submitting}>×</button>
      </header>
      <form className="account-proxy-body" onSubmit={(event) => { event.preventDefault(); if (valid) onSave(trimmed || null); }}>
        <InputField
          label="代理地址"
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="http://user:pass@host:port"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          disabled={submitting}
          data-testid="account-proxy-input"
          aria-invalid={!valid}
          hint="仅支持 HTTP / HTTPS 代理，可带用户名密码。留空则使用服务端默认代理，未配置默认代理时直连。建议每个账号使用独立的国内住宅 IP。"
          error={valid ? undefined : '地址格式不正确，示例：http://user:pass@1.2.3.4:3128'}
        />
        <div className="modal-actions">
          <button className="btn ghost" type="button" data-testid="account-proxy-cancel" onClick={onClose} disabled={submitting}>取消</button>
          {account.proxyUrl && <button className="btn ghost" type="button" data-testid="account-proxy-clear" onClick={() => onSave(null)} disabled={submitting}>清除代理</button>}
          <button className="btn primary" type="submit" data-testid="account-proxy-save" disabled={submitting || !valid}>{submitting ? '保存中…' : '保存'}</button>
        </div>
      </form>
    </section>
  </div>;
}
