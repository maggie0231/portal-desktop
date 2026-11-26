import { expect, it, vi } from 'vitest';
import { ApprovalDialogs } from '../desktop/main/chat/approval-dialogs';
it('binds a single response to its request and rejects stale replies', async () => {
  const publish = vi.fn(); const dialogs = new ApprovalDialogs(publish);
  const waiting = dialogs.request({ title:'test', message:'run', detail:'command', signal:new AbortController().signal });
  const id = dialogs.current()!.id;
  expect(() => dialogs.answer('forged', true)).toThrow();
  dialogs.answer(id, true);
  expect(await waiting).toBe(true);
  expect(dialogs.current()).toBeNull();
  expect(() => dialogs.answer(id, true)).toThrow();
  expect(publish).toHaveBeenLastCalledWith(null);
});
it('distinguishes timeout, cancelled calls, and concurrent requests from user denial', async () => {
  vi.useFakeTimers();
  try {
    const log = vi.fn();
    const dialogs = new ApprovalDialogs(() => {}, log);
    const controller = new AbortController();
    const input = { title:'test', message:'run', detail:'command', signal:controller.signal };
    const waiting = expect(dialogs.request(input)).rejects.toThrow('已取消');
    await expect(dialogs.request(input)).rejects.toThrow('另一个操作');
    controller.abort(); await waiting;
    const expiring = expect(dialogs.request({ ...input, signal:new AbortController().signal })).rejects.toThrow('60 秒');
    const id = dialogs.current()!.id;
    await vi.advanceTimersByTimeAsync(60001);
    await expiring;
    expect(dialogs.current()).toBeNull();
    expect(log).toHaveBeenLastCalledWith({ event: 'settled', id, source: 'timeout', outcome: 'unavailable_or_cancelled', elapsedMs: 60000 });
  } finally { vi.useRealTimers(); }
});

it('denies the active request on native window close and rejects its late reply', async () => {
  const publish = vi.fn();
  const log = vi.fn();
  const dialogs = new ApprovalDialogs(publish, log);
  const prompt = { title: 'test', message: 'run', detail: 'command', signal: new AbortController().signal };
  const first = dialogs.request(prompt);
  const firstId = dialogs.current()!.id;
  dialogs.denyForWindowClose();
  expect(await first).toBe(false);
  expect(publish).toHaveBeenLastCalledWith(null);
  expect(log).toHaveBeenLastCalledWith({ event: 'settled', id: firstId, source: 'window-close', outcome: 'denied', elapsedMs: expect.any(Number) });

  const next = dialogs.request(prompt);
  const nextId = dialogs.current()!.id;
  expect(() => dialogs.answer(firstId, true)).toThrow('审批已过期或不存在');
  expect(log).toHaveBeenLastCalledWith({ event: 'answer-rejected', id: firstId, pendingId: nextId, reason: 'stale-id' });
  dialogs.answer(nextId, true);
  expect(await next).toBe(true);
});
