const accountErrorLabels: Record<string, string> = {
  ACCOUNT_VALIDATION_REQUIRED: '需要安全验证，请在闲鱼完成验证后重新授权。',
  ACCOUNT_REAUTH_REQUIRED: '登录已过期，请重新授权账号。',
  SESSION_EXPIRED: '登录已过期，请重新登录。',
  CREDENTIAL_MISSING: '缺少登录凭证，请重新授权账号。',
  MTOP_TOKEN_EXPIRED: '登录凭证已过期，请重新授权账号。',
  MTOP_TOKEN_MISSING: '缺少登录凭证，请重新授权账号。',
  ACCOUNT_CONTEXT_INVALID: '该账号不可用，请刷新列表后重新选择。',
  ACCOUNT_DELETE_UNAVAILABLE: '账号删除服务暂不可用，请稍后重试。',
  ACCOUNT_MUTATION_UNAVAILABLE: '账号操作服务暂不可用，请稍后重试。',
  PASSWORD_LOGIN_UNAVAILABLE: '暂不支持账号密码登录，请使用扫码或 Cookie 登录。',
  COOKIE_VERIFY_FAILED: '登录凭证校验失败，请复制最新完整 Cookie 后重试。',
  COOKIE_LOGIN_FAILED: 'Cookie 登录失败，请检查凭证后重试。',
  QR_GENERATE_FAILED: '二维码生成失败，请关闭弹窗后重新打开。',
  QR_ACCOUNT_MISMATCH: '扫码账号与当前账号不一致，请使用对应账号重新扫码。',
  QR_LOGIN_UNAVAILABLE: '二维码登录暂不可用，请稍后重试。',
  QR_EXPIRED: '二维码已过期，请关闭弹窗后重新扫码。',
  QR_CONFIRMED_WITHOUT_UNB: '闲鱼未返回登录态，请重新扫码并完成验证。',
  XIANYU_VERIFICATION_TIMEOUT: '二次验证等待超时，请重新扫码并尽快在手机上完成验证。',
  XIANYU_VERIFICATION_URL_INVALID: '闲鱼返回的验证链接无法识别，请重新扫码。',
  XIANYU_VERIFICATION_PAGE_EMPTY: '验证页面加载失败，请重新扫码。',
  XIANYU_VERIFICATION_BROWSER_DISABLED: '服务端未启用验证浏览器，无法完成二次验证。',
  FORBIDDEN: '当前账号没有操作权限。',
  NOT_FOUND: '账号或通知已不存在，请刷新后重试。',
};

export function accountRiskLabel(code?: string): string {
  if (/CAPTCHA|SLIDER|X5SEC|RGV587|FAIL_SYS_USER_VALIDATE/i.test(code ?? '')) return '需滑块验证';
  return '需要安全验证';
}

export function isSliderRiskCode(code?: string): boolean { return /CAPTCHA|SLIDER|X5SEC|RGV587|FAIL_SYS_USER_VALIDATE/i.test(code ?? ''); }

/** 风险来源转成人话，不把后端 source 原文露到页面上。 */
export function accountRiskSourceLabel(source?: string): string {
  const value = (source ?? '').toLowerCase();
  if (!value) return '';
  if (/^im(_|$)|listener|websocket|ws/.test(value)) return '聊天长连接';
  if (/order|trade/.test(value)) return '订单接口';
  if (/login|qr|cookie|token/.test(value)) return '登录流程';
  if (/publish|item|product/.test(value)) return '商品接口';
  if (/message|chat/.test(value)) return '消息接口';
  return '后台接口';
}

export interface AccountStatusAdvice {
  /** 一句话说清是什么情况 */
  summary: string;
  /** 该怎么办 */
  action: string;
  tone: 'ok' | 'warn' | 'danger' | 'gray';
}

/**
 * 把账号状态翻译成「出了什么事 + 该怎么办」，核心是区分开两种最容易混的情况：
 * - 需验证（verification_required）：登录态还在，只是闲鱼弹了滑块/安全验证，系统会自动过滑块，不一定要重新登录；
 * - 已过期（expired）：登录凭证本身失效了，自动过滑块没用，必须重新扫码登录。
 */
export function accountStatusAdvice(account: { status: string; riskCode?: string; riskSource?: string; riskFirstSeenAt?: string; connection?: { status?: string } }): AccountStatusAdvice | null {
  const since = account.riskFirstSeenAt ? formatSince(account.riskFirstSeenAt) : '';
  const source = accountRiskSourceLabel(account.riskSource);
  const where = [source && `触发于${source}`, since && `自 ${since}`].filter(Boolean).join('，');
  switch (account.status) {
    case 'verification_required':
      return isSliderRiskCode(account.riskCode)
        ? { tone: 'warn', summary: `闲鱼弹了滑块验证${where ? `（${where}）` : ''}，登录态没有失效。`, action: '系统会自动调用本机求解器过滑块，通常几分钟内恢复；一直不恢复再点「重新扫码」。' }
        : { tone: 'danger', summary: `闲鱼要求安全验证${where ? `（${where}）` : ''}，可能需要手机确认或人脸。`, action: '先在手机闲鱼 App 完成验证，再点「重新扫码」授权。' };
    case 'expired':
      return { tone: 'danger', summary: '登录凭证已失效（Cookie / Token 过期），自动回复和自动发货都已停止。', action: '必须重新扫码登录，过滑块解决不了这个问题。' };
    case 'degraded':
      return { tone: 'warn', summary: '闲鱼接口临时报错，登录态未失效。', action: '系统会自动重试；持续超过 10 分钟不恢复再重新授权。' };
    case 'disconnected':
      return { tone: 'gray', summary: '账号已断开连接。', action: '点「扫码授权」重新登录即可。' };
    case 'pending':
      return { tone: 'gray', summary: '还没有登录过。', action: '点「扫码授权」完成首次登录。' };
    case 'connected':
      if (account.connection?.status === 'offline') return { tone: 'warn', summary: '登录态正常，但聊天长连接暂时离线。', action: '正在自动重连，无需操作；长时间离线可点「重新授权」。' };
      return null;
    default:
      return null;
  }
}

function formatSince(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay ? date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) : date.toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Raw codes/messages stay in API diagnostics, never in product copy. */
export function accountErrorMessage(error: unknown, fallback: string): string {
  const record = error && typeof error === 'object' ? error as { status?: number; message?: string; payload?: { error?: { code?: string; details?: { errorCode?: string } } } } : undefined;
  const codes = [record?.payload?.error?.details?.errorCode, record?.payload?.error?.code, record?.message];
  for (const code of codes) {
    if (!code) continue;
    if (Object.hasOwn(accountErrorLabels, code)) return accountErrorLabels[code];
    if (code.startsWith('XIANYU_VERIFICATION_AUTO_SOLVE_FAILED')) return '滑块验证未通过，请重新扫码后重试。';
    if (/CAPTCHA|SLIDER|X5SEC|RGV587|FAIL_SYS_USER_VALIDATE/i.test(code)) return '需要安全验证，请在闲鱼完成验证后重新授权。';
  }
  if (record?.status === 401) return '登录已过期，请重新登录。';
  if (record?.status === 403) return '当前账号没有操作权限。';
  if (record?.status === 404) return '账号或通知已不存在，请刷新后重试。';
  if (record?.status === 429) return '操作过于频繁，请稍后重试。';
  if (record?.status === 504) return '请求超时，请稍后重试。';
  if (error instanceof TypeError) return '账号服务暂时不可用，请检查连接后重试。';
  return fallback;
}
