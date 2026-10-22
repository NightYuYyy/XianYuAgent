import { useCallback, useEffect, useState } from 'react';
import type { SystemApi } from '../api';
import type { SliderSolverStatusVM } from '../types';
import { Button } from '../../../shared/ui/Button';

type Phase = 'loading' | 'ready' | 'error';

/**
 * Settings → 滑块求解器. The physical-mouse solver lives on a Windows desktop
 * (tools/realmouse-solver) and reaches the server through an SSH reverse
 * tunnel, so the question operators actually have is "is it up right now?".
 * This card answers that from the API's own probe; it never edits config,
 * because the endpoint/secret live in the server .env and need a restart.
 */
export function SliderSolverPanel({ api }: { api: SystemApi }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [status, setStatus] = useState<SliderSolverStatusVM | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPhase('loading');
    setError(null);
    try {
      setStatus(await api.getSliderSolverStatus());
      setPhase('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取求解器状态失败');
      setPhase('error');
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const probe = status?.probe;
  const stats = probe?.stats ?? {};
  const realMouse = stats.real_mouse_available === true;
  const tone: 'ok' | 'warn' | 'danger' = !status?.configured ? 'warn' : probe?.reachable && realMouse ? 'ok' : 'danger';
  const headline = !status?.configured ? '未配置' : probe?.reachable ? (realMouse ? '在线' : '在线（无真人鼠标引擎）') : '不可达';
  const detail = !status?.configured
    ? '服务器 .env 没有 XIANYU_SLIDER_REMOTE_URL / SECRET，滑块只能走本地算法或人工。'
    : probe?.reachable
      ? `探测 ${probe.latencyMs} ms · 本机 ${String(stats.platform ?? '?')}`
      : `探测失败：${describeProbeError(probe?.error)}。先确认 Windows 上的 run-detached.ps1 在跑，再看 logs/tunnel.log。`;

  return <div className="settings-content" data-slider-solver-panel>
    <article className="card panel settings-hero"><div><p className="eyebrow">Remote Solver</p><h2>滑块求解器</h2><p>闲鱼风控拒绝 CDP 注入的滑块，只认真实鼠标。求解器跑在有桌面的 Windows 上，经 SSH 反向隧道供服务器调用；这里只看它此刻是否可用。</p></div><span className="settings-scope-chip">只读 · 配置在服务器 .env</span></article>
    {phase === 'error' && <div className="settings-state error" role="alert"><strong>{error}</strong><Button variant="ghost" type="button" onClick={() => void load()}>重试</Button></div>}
    {phase === 'loading' && !status && <div className="settings-state loading"><span className="settings-spinner" />正在探测求解器…</div>}
    {status && <article className="card panel">
      <div className="panel-head"><div><h2><span className={`status-pill ${tone}`} data-solver-state={tone}>{headline}</span></h2><p>{detail}</p></div><Button variant="primary" type="button" disabled={phase === 'loading'} onClick={() => void load()}>{phase === 'loading' ? '探测中…' : '重新探测'}</Button></div>
      <div className="settings-reference-list">
        <div><strong>求解地址</strong><span>{status.endpoint ?? '—'}</span><em>{status.configured ? '已配置' : '未配置'}</em></div>
        <div><strong>不可达时</strong><span>{status.fallback === 'none' ? '直接判失败' : '回退本地浏览器算法'}</span><em>XIANYU_SLIDER_REMOTE_FALLBACK</em></div>
        <div><strong>超时</strong><span>整次 {Math.round(status.timeoutMs / 1000)} s · 浏览器 {status.browserTimeoutSeconds} s</span><em>服务器侧</em></div>
        <div><strong>本地滑块算法</strong><span>{status.localSliderMode === 'auto' ? '开启（远程失败后尝试）' : '关闭'}</span><em>XIANYU_VERIFICATION_SLIDER_MODE</em></div>
        {probe?.reachable && <>
          <div><strong>真人鼠标引擎</strong><span>{realMouse ? '可用' : '不可用，检查是否在 Windows 桌面会话里运行'}</span><em>real_mouse_available</em></div>
          <div><strong>累计请求</strong><span>{formatCounter(stats.requests)} 次 · 通过 {formatCounter(stats.success)} · 失败 {formatCounter(stats.failed)} · 链接过期 {formatCounter(stats.url_expired)}</span><em>自求解器启动起</em></div>
          <div><strong>最近一次结果</strong><span>{typeof stats.last_result_at === 'string' && stats.last_result_at ? stats.last_result_at : '尚无请求'}</span><em>Windows 本机时间</em></div>
        </>}
        <div><strong>探测时间</strong><span>{formatTime(status.checkedAt)}</span><em>服务器时间</em></div>
      </div>
      <div className="settings-editor-note"><strong>排障顺序</strong><span>① Windows 上 <code>tools/realmouse-solver/run-detached.ps1</code> 是否在跑；② 隧道日志 logs/tunnel.log 是否反复 reconnecting（服务器上 <code>ss -ltnp | grep 18095</code> 找僵尸 sshd 并 kill）；③ 服务器 .env 的 XIANYU_SLIDER_REMOTE_SECRET 与本机 .env 的 SOLVER_SECRET 是否一致。详见仓库 tools/realmouse-solver/README.md。</span></div>
    </article>}
  </div>;
}

function describeProbeError(code?: string): string {
  switch (code) {
    case 'TIMEOUT': return '连接超时，隧道可能半开';
    case 'UNREACHABLE': return '连接被拒绝，隧道或求解器没在跑';
    case 'INVALID_URL': return '求解地址不是合法 URL';
    case 'INVALID_JSON': return '返回的不是求解器的 JSON，端口可能被别的服务占了';
    default: return code?.startsWith('HTTP_') ? `求解器返回 ${code.slice(5)}` : (code ?? '未知原因');
  }
}

function formatCounter(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '0';
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}
