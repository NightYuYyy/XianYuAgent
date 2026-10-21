import { useEffect, useMemo, useRef, useState } from 'react';
import { useAccountContext } from '../../../app/account-context';
import { createAccountsApi, createMockAccountsApi, type AccountsApi } from '../api';
import { resolveRuntimeApi } from '../../../api/runtime';
import { useAccountsController } from '../controller';
import type { AccountVM } from '../types';
import { AccountTable } from './AccountTable';
import { AccountStateView } from './AccountStateView';
import { AccountToolbar } from './AccountToolbar';
import { AccountLoginModal } from './AccountLoginModal';
import { AccountDeleteModal } from './AccountDeleteModal';
import { AccountProxyModal } from './AccountProxyModal';
import type { AccountLoginMethod } from './LoginMethodSelector';
import { findReauthorizeAccount, readReauthorizeAccountId } from '../reauthorize-intent';
import { accountErrorMessage } from '../feedback';
import { useToast } from '../../../shared/ui/ToastProvider';
import './accounts.css';

export interface AccountsPageProps { api?: AccountsApi; }

export function AccountsPage({ api: providedApi }: AccountsPageProps) {
  const api = useMemo(() => resolveRuntimeApi(providedApi, createMockAccountsApi, 'ACCOUNTS_API_NOT_PROVIDED'), [providedApi]);
  const controller = useAccountsController({ api });
  const { showToast, dismissToast } = useToast();
  const previousLoadError = useRef<string | null>(null);
  const { accounts: contextAccounts, accountsLoading, currentAccountId, currentAccount, setCurrentAccountId, removeAccount, refreshAccounts } = useAccountContext();
  const [loginAccountId, setLoginAccountId] = useState<string | null>(null);
  const [loginMethod, setLoginMethod] = useState<AccountLoginMethod>('qr');
  const [loginOpen, setLoginOpen] = useState(false);
  const [handledReauthorizeAccountId, setHandledReauthorizeAccountId] = useState<string | null>(null);
  const [deleteAccountTarget, setDeleteAccountTarget] = useState<AccountVM | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [proxyAccountTarget, setProxyAccountTarget] = useState<AccountVM | null>(null);
  const [proxySubmitting, setProxySubmitting] = useState(false);
  const accounts = controller.state.data?.items ?? [];
  const total = controller.state.data?.total ?? 0;
  const page = controller.state.data?.page ?? controller.filters.page ?? 1;
  const totalPages = controller.state.data?.totalPages ?? 1;
  const metrics = summarize(accounts);
  const loginAccount = loginAccountId ? accounts.find((account) => account.id === loginAccountId) ?? contextAccounts.find((account) => account.id === loginAccountId) : undefined;
  const requestedReauthorizeAccountId = useMemo(() => readReauthorizeAccountId(typeof window === 'undefined' ? '' : window.location.search), []);

  useEffect(() => {
    const error = controller.state.error;
    if (error && error.message !== previousLoadError.current) {
      showToast({ id: 'account-list', tone: 'error', message: error.message, actions: error.retryable ? [{ label: '重新加载', onClick: () => { void controller.reload(); } }] : [] });
    }
    if (controller.state.phase === 'success' || controller.state.phase === 'empty') dismissToast('account-list');
    previousLoadError.current = error?.message ?? null;
  }, [controller.state.error, controller.state.phase, controller.reload, showToast, dismissToast]);

  useEffect(() => {
    if (!requestedReauthorizeAccountId || handledReauthorizeAccountId === requestedReauthorizeAccountId || accountsLoading) return;
    const account = findReauthorizeAccount(contextAccounts, requestedReauthorizeAccountId) ?? findReauthorizeAccount(accounts, requestedReauthorizeAccountId);
    if (!account) return;
    setLoginAccountId(account.id);
    setLoginMethod('cookie');
    setLoginOpen(true);
    setHandledReauthorizeAccountId(requestedReauthorizeAccountId);
    const url = new URL(window.location.href);
    url.searchParams.delete('reauthorize');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, [accounts, accountsLoading, contextAccounts, handledReauthorizeAccountId, requestedReauthorizeAccountId]);

  function openLogin(account?: AccountVM, method: AccountLoginMethod = 'qr') {
    setLoginAccountId(account?.id ?? null);
    setLoginMethod(method);
    setLoginOpen(true);
  }

  function closeLogin() {
    setLoginOpen(false);
    setLoginAccountId(null);
    setLoginMethod('qr');
  }

  async function switchAccount(account: AccountVM) {
    try {
      await setCurrentAccountId(account.id);
    } catch (error) {
      showToast({ id: 'account-switch', tone: 'error', message: accountErrorMessage(error, '账号切换失败，请稍后重试。') });
    }
  }

  function requestDeleteAccount(account: AccountVM) {
    setDeleteAccountTarget(account);
  }

  async function saveProxy(proxyUrl: string | null) {
    if (!proxyAccountTarget || !api.updateAccount) return;
    setProxySubmitting(true);
    try {
      await api.updateAccount(proxyAccountTarget.id, { proxyUrl });
      showToast({ id: 'account-proxy', tone: 'success', message: proxyUrl ? '代理已保存，后续请求将经该代理出站。' : '已清除代理，账号将使用默认连接。' });
      setProxyAccountTarget(null);
      void controller.reload();
      void refreshAccounts();
    } catch (error) {
      showToast({ id: 'account-proxy', tone: 'error', message: accountErrorMessage(error, '代理保存失败，请检查地址格式后重试。') });
    } finally {
      setProxySubmitting(false);
    }
  }

  function closeDeleteAccount() {
    if (deleteSubmitting) return;
    setDeleteAccountTarget(null);
  }

  async function confirmDeleteAccount() {
    if (!deleteAccountTarget || deleteSubmitting) return;
    const account = deleteAccountTarget;
    setDeleteSubmitting(true);
    dismissToast('account-delete');
    try {
      await removeAccount(account.id);
      setDeleteAccountTarget(null);
      await controller.reload();
    } catch (error) {
      showToast({ id: 'account-delete', tone: 'error', message: accountErrorMessage(error, '账号删除失败，请稍后重试。') });
    } finally {
      setDeleteSubmitting(false);
    }
  }

  return (
    <section className="page-stack accounts-domain" data-accounts-domain>
      <div className="kpi-grid three accounts-domain-kpis">
        <article className="card kpi-card"><div className="kpi-label">已绑定账号</div><div className="kpi-value">{total}</div><div className="kpi-delta"><span className="tone-ok">{metrics.online} 个在线</span><small>当前可用连接</small></div></article>
        <article className="card kpi-card"><div className="kpi-label">当前账号</div><div className="kpi-value">{currentAccount?.displayName?.slice(-1) ?? '—'}</div><div className="kpi-delta"><span className="tone-info">账号上下文</span><small>{currentAccount?.displayName ?? '请先选择账号'}</small></div></article>
        <article className="card kpi-card"><div className="kpi-label">需要处理</div><div className="kpi-value">{metrics.needsAttention}</div><div className="kpi-delta"><span className={metrics.needsAttention > 0 ? 'tone-warn' : 'tone-ok'}>{metrics.needsAttention > 0 ? '需要刷新或补凭证' : '状态健康'}</span><small>不展示敏感凭证</small></div></article>
      </div>
      <article className="card panel accounts-domain-panel">
        <AccountToolbar filters={controller.filters} phase={controller.state.phase} onSearchChange={controller.setSearch} onStatusChange={(status) => controller.setFilters((previous) => ({ ...previous, status, page: 1 }))} onConnectionStatusChange={(connectionStatus) => controller.setFilters((previous) => ({ ...previous, connectionStatus, page: 1 }))} onRefresh={controller.reload} onAddAccount={() => openLogin()} />
        {controller.state.phase === 'success' && <AccountTable accounts={accounts} activeAccountId={currentAccountId} page={page} total={total} totalPages={totalPages} onPageChange={(nextPage) => controller.setFilters((previous) => ({ ...previous, page: Math.max(1, Math.min(nextPage, totalPages)) }))} onEditProxy={api.updateAccount ? (account) => setProxyAccountTarget(account) : undefined} onReauthorize={openLogin} onSwitch={switchAccount} onDelete={requestDeleteAccount} />}
        <AccountStateView phase={controller.state.phase} error={controller.state.error} onRetry={controller.reload} />
      </article>
      {loginOpen && <AccountLoginModal api={api} account={loginAccount} initialMethod={loginMethod} onClose={closeLogin} onStatusChanged={() => { void controller.reload(); void refreshAccounts(); }} onCompleted={() => { void controller.reload(); void refreshAccounts(); closeLogin(); }} />}
      {deleteAccountTarget && <AccountDeleteModal account={deleteAccountTarget} submitting={deleteSubmitting} onClose={closeDeleteAccount} onConfirm={() => { void confirmDeleteAccount(); }} />}
      {proxyAccountTarget && <AccountProxyModal account={proxyAccountTarget} submitting={proxySubmitting} onClose={() => { if (!proxySubmitting) setProxyAccountTarget(null); }} onSave={(proxyUrl) => { void saveProxy(proxyUrl); }} />}
    </section>
  );
}

export function summarize(accounts: AccountVM[]) {
  return {
    online: accounts.filter((account) => account.status === 'connected' && account.connection.status === 'online').length,
    needsAttention: accounts.filter((account) => (account.status !== 'connected' && account.status !== 'disabled') || ['expired', 'unknown'].includes(account.connection.status) || ['refresh_required', 'missing'].includes(account.credentialState)).length,
  };
}

export { createAccountsApi };
