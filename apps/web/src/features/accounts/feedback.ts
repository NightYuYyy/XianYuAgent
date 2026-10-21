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
