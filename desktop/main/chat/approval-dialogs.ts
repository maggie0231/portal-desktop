import { randomUUID } from 'node:crypto';
import type { ApprovalPrompt } from './tool-approval';
import { TOOL_APPROVAL_TIMEOUT_MS, type ToolApprovalView } from '../../shared/security';

type Cancellation = 'quit' | 'settings-change';
type Settlement = Cancellation | 'renderer' | 'window-close' | 'timeout' | 'aborted';
const approvalIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** Only the source-checked top-level shell can resolve these one-shot requests. */
export class ApprovalDialogs {
  private pending?: { view: ToolApprovalView; finish: (source: Settlement, result: boolean | Error) => void };
  constructor(
    private publish: (request: ToolApprovalView | null) => void,
    private log?: (entry: object) => void,
  ) {}
  current() { return this.pending?.view ?? null; }
  request(input: ApprovalPrompt): Promise<boolean> {
    if (input.signal.aborted) return Promise.reject(new Error('审批调用已取消，操作未执行'));
    if (this.pending) return Promise.reject(new Error('另一个操作正在等待审批，请完成后再试'));
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const view = { id: randomUUID(), title: input.title, message: input.message, detail: input.detail, livePermissionMode: input.livePermissionMode, expiresAt: startedAt + TOOL_APPROVAL_TIMEOUT_MS };
      const abort = () => finish('aborted', new Error('审批调用已取消，操作未执行'));
      const finish = (source: Settlement, result: boolean | Error) => {
        if (this.pending?.view.id !== view.id) return;
        clearTimeout(timer);
        input.signal.removeEventListener('abort', abort);
        this.pending = undefined;
        const outcome = typeof result === 'boolean' ? (result ? 'allowed' : 'denied') : 'unavailable_or_cancelled';
        this.log?.({ event: 'settled', id: view.id, source, outcome, elapsedMs: Date.now() - startedAt });
        if (typeof result === 'boolean') resolve(result);
        else reject(result);
        this.publish(null);
      };
      const timer = setTimeout(() => finish('timeout', new Error('审批等待超过 60 秒，操作未执行；请重新发起并在弹窗中允许')), TOOL_APPROVAL_TIMEOUT_MS);
      this.pending = { view, finish };
      input.signal.addEventListener('abort', abort, { once: true });
      this.log?.({ event: 'requested', id: view.id, expiresAt: view.expiresAt });
      this.publish(view);
    });
  }
  answer(id: unknown, allowed: unknown) {
    const pending = this.pending;
    const approvalId = typeof id === 'string' && approvalIdPattern.test(id) ? id : undefined;
    if (!approvalId || typeof allowed !== 'boolean' || pending?.view.id !== approvalId) {
      const reason = approvalId && typeof allowed === 'boolean' ? 'stale-id' : 'invalid-input';
      this.log?.({ event: 'answer-rejected', id: approvalId, pendingId: pending?.view.id, reason });
      throw new Error('审批已过期或不存在');
    }
    this.log?.({ event: 'answer-received', id: approvalId, allowed });
    pending.finish('renderer', allowed);
  }
  denyForWindowClose() { this.pending?.finish('window-close', false); }
  cancel(source: Cancellation) {
    this.pending?.finish(source, new Error('客户端关闭或配置已更改，审批已取消，操作未执行'));
  }
}
