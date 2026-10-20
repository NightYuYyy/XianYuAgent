import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Toast, type ToastAction, type ToastTone } from './Toast';

export interface ToastNotice {
  id?: string;
  message: ReactNode;
  tone?: ToastTone;
  actions?: ToastAction[];
  durationMs?: number;
}

interface ToastContextValue {
  showToast: (notice: ToastNotice) => string;
  dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/** One shared viewport for notifications; new errors take priority without overlapping. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<Array<ToastNotice & { id: string }>>([]);
  const nextId = useRef(0);
  const showToast = useCallback((notice: ToastNotice) => {
    const id = notice.id ?? `toast-${++nextId.current}`;
    setNotices((previous) => [{ ...notice, id }, ...previous.filter((item) => item.id !== id)]);
    return id;
  }, []);
  const dismissToast = useCallback((id: string) => setNotices((previous) => previous.filter((item) => item.id !== id)), []);
  const active = notices[0];
  useEffect(() => {
    if (!active || active.durationMs === 0) return;
    const timeout = window.setTimeout(() => dismissToast(active.id), active.durationMs ?? 6000);
    return () => window.clearTimeout(timeout);
  }, [active, dismissToast]);
  const value = useMemo(() => ({ showToast, dismissToast }), [showToast, dismissToast]);
  return <ToastContext.Provider value={value}>{children}{active && <Toast message={active.message} tone={active.tone} actions={active.actions} onDismiss={() => dismissToast(active.id)} />}</ToastContext.Provider>;
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside ToastProvider');
  return context;
}
