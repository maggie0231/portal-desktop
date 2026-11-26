import { dropdownMenuPopover } from '../../shared/components/animate-ui/dropdown-menu-motion';
import styles from './permissions.module.scss';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Dialog } from '../../shared/components/dialog';
import { PermissionIcon } from '../../shared/icons/permission';
import { permissionChoices } from '../../shared/lib/permissions';
import type { AppModel } from '../models/app';
import type { PermissionMode, ToolApprovalView } from '../../../shared/security';

export function PermissionSettings({ app, approval, close = app.closePermissionSettings,
  anchor: menuAnchor = app.permissionAnchor }: { app: AppModel; approval?: ToolApprovalView; close?: () => void; anchor?: AppModel['permissionAnchor'] }) {
  const open = Boolean(approval) || app.permissionSettingsOpen;
  const menu = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mode = app.snapshot?.settings.permissionMode ?? 'supervised';
  useLayoutEffect(() => {
    const element = menu.current!;
    if (!open) { if (element.matches(':popover-open')) element.hidePopover(); return; }
    setError('');
    element.showPopover();
    const position = () => {
      const anchor = menuAnchor ?? { left: 80, top: innerHeight - 100, bottom: innerHeight - 68 };
      const { offsetWidth: width, offsetHeight: height } = element;
      const left = Math.max(8, Math.min(anchor.left, innerWidth - width - 8));
      const top = anchor.top - height - 8 >= 8 ? anchor.top - height - 8
        : Math.max(8, Math.min(anchor.bottom + 8, innerHeight - height - 8));
      element.style.left = `${left}px`; element.style.top = `${top}px`;
      element.style.transformOrigin = `${anchor.left - left}px ${top < anchor.top ? "bottom" : "top"}`;
    };
    position();
    const observer = new ResizeObserver(position); observer.observe(element);
    element.querySelector<HTMLButtonElement>('[aria-checked=true]')?.focus();
    const resized = () => close();
    window.addEventListener('resize', resized);
    return () => { observer.disconnect(); window.removeEventListener('resize', resized); };
  }, [open, menuAnchor, close]);
  const apply = async (nextMode: PermissionMode) => {
    if (!app.snapshot || busy) return;
    if (nextMode === mode) { close(); return; }
    setBusy(true); setError('');
    try {
      if (approval) {
        if (!approval.livePermissionMode || !app.api.setToolApprovalMode) throw new Error('此 Portal 版本不支持在审批中切换权限，请先完成本次审批');
        await app.api.setToolApprovalMode(approval.id, nextMode);
        app.applySnapshot(await app.api.snapshot());
      } else {
        app.applySnapshot(await app.api.save({ ...app.snapshot.settings, permissionMode: nextMode }));
      }
      close();
    }
    catch (e) { setError(e instanceof Error ? e.message : '无法应用权限设置'); }
    finally { setBusy(false); }
  };
  return <div ref={menu} popover="auto" {...dropdownMenuPopover} role="menu" aria-label="电脑操作权限" aria-busy={busy} className={styles.menu}
    onToggle={event => { if (event.newState === 'closed' && open) close(); }}
    onKeyDown={event => {
      if (event.repeat && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      if (!items.length) return;
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[next].focus();
    }}>
    <div className={styles.heading}>在此电脑上运行</div>
    {permissionChoices.map(choice => <button key={choice.value} type="button" role="menuitemradio" aria-checked={choice.value === mode}
      tabIndex={choice.value === mode ? 0 : -1} data-mode={choice.value} disabled={busy || !app.snapshot?.settings.hasToken} onClick={() => void apply(choice.value)}>
      <PermissionIcon mode={choice.value}/><span className={styles.copy}><strong>{choice.title}</strong><small>{choice.detail}</small></span>
    </button>)}
    <div className={styles.menuNote} role="status">{busy ? '正在切换…' : approval ? '从下一笔操作生效，本次仍需单独审批' : '切换会重启运行时，中断当前本机任务'}</div>
    {error && <p role="alert" className={styles.menuError}>{error}</p>}
  </div>;
}

type ApprovalAction = 'allow' | 'deny' | 'close' | 'dismiss';

function logApproval(entry: object) {
  console.info(`[approval-ui] ${JSON.stringify(entry)}`);
}

export function ToolApprovalDialog({ app }: { app: AppModel }) {
  const [request, setRequest] = useState<ToolApprovalView | null>(null);
  const [settings, setSettings] = useState<{ id: string; anchor: DOMRect }>();
  const manageButton = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const answering = useRef<string | null>(null);
  const requestId = useRef<string | null>(null);
  const suppressedRepeats = useRef(0);
  const attachAllowButton = useCallback((button: HTMLButtonElement | null) => {
    // showModal() reads the native attribute. React's autoFocus prop focuses on mount.
    if (button) button.autofocus = true;
  }, []);
  const id = request?.id;
  const closeMenu = useCallback(() => {
    setSettings(current => current?.id === id ? undefined : current);
    if (requestId.current === id) manageButton.current?.focus();
  }, [id]);
  useLayoutEffect(() => {
    if (!id) return;
    suppressedRepeats.current = 0;
    logApproval({ event: 'opened', id, focus: document.activeElement?.getAttribute('data-approval-action') ?? 'other' });
    return () => logApproval({ event: 'closed', id, suppressedRepeats: suppressedRepeats.current });
  }, [id]);
  useEffect(() => {
    let active = true, changed = false;
    const receive = (value: ToolApprovalView | null, source: 'push' | 'pending') => {
      requestId.current = value?.id ?? null;
      if (value) logApproval({ event: 'received', id: value.id, source });
      setRequest(value);
      setBusy(false);
      setError('');
    };
    const off = app.api.onToolApproval?.(value => { changed = true; receive(value, 'push'); });
    void app.api.toolApprovalPending?.().then(value => {
      if (active && !changed) receive(value, 'pending');
    }).catch(() => {
      if (active && !changed) logApproval({ event: 'pending-read-failed' });
    });
    return () => { active = false; off?.(); };
  }, [app]);
  async function answer(action: ApprovalAction, event?: MouseEvent<HTMLButtonElement>) {
    if (!id || busy || answering.current === id) return;
    const allowed = action === 'allow';
    answering.current = id;
    setBusy(true);
    const input = event ? (event.detail > 0 ? 'pointer' : 'keyboard-or-assistive') : 'dialog-dismiss';
    logApproval({ event: 'submitting', id, action, input, allowed });
    try {
      if (!app.api.answerToolApproval) throw new Error('客户端审批通道不可用');
      await app.api.answerToolApproval(id, allowed);
      logApproval({ event: 'answer-acknowledged', id });
      setRequest(current => current?.id === id ? null : current);
    } catch (e) {
      logApproval({ event: 'answer-failed', id });
      if (requestId.current === id) setError(e instanceof Error ? e.message : '审批失败');
    } finally {
      if (answering.current === id) answering.current = null;
      if (!requestId.current || requestId.current === id) setBusy(false);
    }
  }
  function guardActivation(event: KeyboardEvent<HTMLDialogElement>) {
    const activatesButton = event.key === 'Enter' || event.key === ' ';
    if (!activatesButton && !(event.key === 'Escape' && event.repeat)) return;
    if (event.repeat) suppressedRepeats.current++;
    else if (!event.nativeEvent.isComposing && event.keyCode !== 229) return;
    event.preventDefault();
  }
  // Native buttons activate on Space keyup. A new request needs fresh button press state.
  return <Dialog key={id} open={Boolean(id)} busy={busy} onClose={() => void answer('dismiss')} onKeyDownCapture={guardActivation} className={styles.dialog} aria-labelledby="tool-approval-title">
    <header className={styles.header}>
      <span className={styles.headerIcon}><PermissionIcon/></span><div><h2 id="tool-approval-title">此操作需要你的允许</h2><p>仅对当前这一次调用生效</p></div>
      <button type="button" aria-label="关闭" aria-disabled={busy} data-approval-action="close" onClick={event => void answer('close', event)}>×</button>
    </header>
    <div className={styles.body}><strong className={styles.action}>{request?.message}</strong><pre className={styles.request}>{request?.detail}</pre>
      <p className={styles.note}>关闭即拒绝 · 1 分钟后自动过期 · 不会记住此授权</p>{error && <p role="alert" className="form-error">{error}</p>}</div>
    <footer className={styles.footer}>
      <button type="button" ref={manageButton} className={styles.manage} aria-disabled={busy} data-approval-action="settings" onClick={event => {
        if (!id || busy) return;
        logApproval({ event: 'settings-opened', id });
        setSettings({ id, anchor: event.currentTarget.getBoundingClientRect() });
      }}>调整权限…</button>
      <button type="button" aria-disabled={busy} data-approval-action="deny" onClick={event => void answer('deny', event)}>拒绝</button>
      <button type="button" ref={attachAllowButton} className="primary" aria-disabled={busy} data-approval-action="allow" onClick={event => void answer('allow', event)}>允许这一次</button>
    </footer>
    {settings && settings.id === id && request && <PermissionSettings app={app} approval={request} close={closeMenu} anchor={settings.anchor}/>}
  </Dialog>;
}
