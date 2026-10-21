import { qrStatusLabel, secondsUntilQrExpiry, type QrLoginModel } from '../model';

interface QrLoginViewProps {
  model: QrLoginModel;
}

export function QrLoginView({ model }: QrLoginViewProps) {
  const session = model.session;
  const terminal = ['succeeded', 'expired', 'failed', 'cancelled', 'verification_required'].includes(model.phase);
  const badgeClass = session?.status === 'succeeded'
    ? 'badge-ok'
    : session?.status === 'failed' || session?.status === 'expired'
      ? 'badge-danger'
      : session?.status === 'verification_required'
        ? 'badge-warn'
        : 'badge-info';

  return (
    <div className="qr-login-view">
      <div className={`qr-login-status-row${session ? '' : ' qr-login-status-row-placeholder'}`} aria-hidden={session ? undefined : true}>
        <span className={`badge ${session ? badgeClass : 'badge-info'}`}>{session ? qrStatusLabel(session.status) : '等待扫码'}</span>
        <span className="qr-login-expiry">{session ? (terminal ? '' : `二维码有效期 ${formatQrExpiry(secondsUntilQrExpiry(session.expiresAt))}`) : '二维码有效期 00:00'}</span>
      </div>
      {!session && (model.phase === 'creating' || model.phase === 'idle') && <div className="qr-login-code qr-login-code-loading" role="status" aria-live="polite"><div className="qr-login-loading-content"><span className="qr-login-spinner" aria-hidden="true"/><strong>{model.phase === 'creating' ? '正在生成二维码' : '准备二维码登录'}</strong><span>{model.phase === 'creating' ? '正在创建账号登录会话，请稍候。' : '二维码会在弹窗打开后自动生成。'}</span></div></div>}
      {!session && model.phase === 'failed' && <div className="qr-login-code qr-login-code-loading"><div className="qr-login-loading-content"><strong>二维码暂不可用</strong><span>请关闭弹窗后重新打开以重试。</span></div></div>}
      {session && <>
        <div className="qr-login-code">
          {session.faceQrImageDataUrl ? <><img src={session.faceQrImageDataUrl} alt="闲鱼人脸验证二维码" data-testid="qr-login-face-qr"/><span className="qr-login-help">闲鱼要求人脸验证：打开闲鱼 App → 扫一扫 → 按提示刷脸</span><span className="qr-login-note">刷脸通过后这里会自动完成登录</span></> : session.qrImageDataUrl ? <><img src={session.qrImageDataUrl} alt="闲鱼二维码登录"/><span className="qr-login-help">打开闲鱼 App → 扫一扫</span><span className="qr-login-note">请勿截屏或转发二维码</span></> : <div className="qr-login-placeholder"><strong>二维码暂不可用</strong><span>请关闭弹窗后重新打开。</span></div>}
        </div>
        {session.verificationUrl && !session.faceQrImageDataUrl && !(session.verificationAutoLaunch && isIdentityVerification(session.verificationUrl)) && <a className="qr-login-link" href={session.verificationUrl} target="_blank" rel="noreferrer">在新窗口打开验证链接</a>}
        {session.status === 'verification_required' && <div className="qr-login-error" role="alert"><strong>{session.faceQrImageDataUrl ? '请扫码完成人脸验证' : isIdentityVerification(session.verificationUrl) ? '需要在手机上完成二次验证' : '需要完成人工验证'}</strong><span>{verificationHint(session)}</span></div>}
        {session.status === 'succeeded' && <div className="qr-login-success" role="status"><strong>账号已重新连接</strong><span>凭证已由服务端保存并完成登录态校验。</span></div>}
      </>}
    </div>
  );
}

/** Havana identity verification (人脸/短信) lives under passport `/iv/`; it is completed on the phone, not on this page. */
function isIdentityVerification(verificationUrl?: string): boolean {
  return /\/iv\/|havana_iv_token|mini_login_check/i.test(verificationUrl ?? '');
}

function verificationHint(session: { verificationUrl?: string; verificationAutoLaunch?: boolean; faceQrImageDataUrl?: string }): string {
  if (session.faceQrImageDataUrl) return '请用闲鱼 App 扫描上方二维码并完成人脸验证。验证链接是一次性的，请不要再用浏览器打开它。';
  if (isIdentityVerification(session.verificationUrl)) {
    return session.verificationAutoLaunch
      ? '闲鱼要求人脸或短信验证。请在手机闲鱼 App 上完成验证，期间请勿关闭此弹窗；服务端会等待验证结果并自动完成登录。'
      : '闲鱼要求人脸或短信验证。请打开验证链接并在手机上完成验证后重新扫码。';
  }
  return session.verificationAutoLaunch
    ? '验证页已由浏览器打开，请完成页面上的验证；完成后系统会自动继续登录。'
    : '闲鱼已要求额外验证。请打开验证链接完成验证后再重试，系统不会伪造登录成功。';
}

function formatQrExpiry(seconds: number): string {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
  const remainingSeconds = Math.max(0, seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remainingSeconds}`;
}
