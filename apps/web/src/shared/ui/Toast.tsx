import type { ReactNode } from 'react';
import './toast.css';

export type ToastTone = 'success' | 'error' | 'info';
export interface ToastAction { label: string; onClick: () => void; disabled?: boolean; }

export function Toast({ message, tone = 'info', actions = [], onDismiss }: { message: ReactNode; tone?: ToastTone; actions?: ToastAction[]; onDismiss?: () => void }) {
  return <div className={`app-toast app-toast-${tone}`} role={tone === 'error' ? 'alert' : 'status'} aria-live={tone === 'error' ? 'assertive' : 'polite'}>
    <div className="app-toast-content"><span>{message}</span>{actions.length > 0 && <div className="app-toast-actions">{actions.map((action) => <button key={action.label} type="button" disabled={action.disabled} onClick={action.onClick}>{action.label}</button>)}</div>}</div>
    {onDismiss && <button type="button" className="app-toast-dismiss" aria-label="关闭提示" onClick={onDismiss}>×</button>}
  </div>;
}
