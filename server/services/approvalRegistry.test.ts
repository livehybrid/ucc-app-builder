import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApprovalRegistry } from './approvalRegistry.js';

describe('ApprovalRegistry — pending-promise resolution', () => {
  let reg: ApprovalRegistry;
  beforeEach(() => {
    reg = new ApprovalRegistry();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('register returns an id + a promise that the approve endpoint resolves', async () => {
    const { approvalId, promise } = reg.register({ tool: 'run_splunk_query', sessionId: 's1' });
    expect(reg.has(approvalId)).toBe(true);
    expect(reg.size).toBe(1);

    const ok = reg.resolve(approvalId, 'approve');
    expect(ok).toBe(true);
    const outcome = await promise;
    expect(outcome).toEqual({ decision: 'approve', timedOut: false });
    // Settled → no longer pending.
    expect(reg.has(approvalId)).toBe(false);
    expect(reg.size).toBe(0);
  });

  it('approve_session decision flows through unchanged', async () => {
    const { approvalId, promise } = reg.register({ tool: 'get_live_indexes', sessionId: 's1' });
    reg.resolve(approvalId, 'approve_session');
    expect((await promise).decision).toBe('approve_session');
  });

  it('deny decision flows through', async () => {
    const { approvalId, promise } = reg.register({ tool: 'get_live_indexes', sessionId: 's1' });
    reg.resolve(approvalId, 'deny');
    expect(await promise).toEqual({ decision: 'deny', timedOut: false });
  });

  it('timeout settles as deny and fires onTimeout', async () => {
    const onTimeout = vi.fn();
    const { promise } = reg.register({
      tool: 'run_splunk_query',
      sessionId: 's1',
      timeoutMs: 1000,
      onTimeout,
    });
    vi.advanceTimersByTime(1000);
    const outcome = await promise;
    expect(outcome).toEqual({ decision: 'deny', timedOut: true });
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(reg.size).toBe(0);
  });

  it('resolve() on an unknown / already-settled id returns false', () => {
    expect(reg.resolve('nope', 'approve')).toBe(false);
    const { approvalId } = reg.register({ tool: 't', sessionId: 's' });
    expect(reg.resolve(approvalId, 'approve')).toBe(true);
    // Second resolve is a no-op.
    expect(reg.resolve(approvalId, 'deny')).toBe(false);
  });

  it('a resolved approval no longer fires its timeout', async () => {
    const onTimeout = vi.fn();
    const { approvalId, promise } = reg.register({
      tool: 't',
      sessionId: 's',
      timeoutMs: 1000,
      onTimeout,
    });
    reg.resolve(approvalId, 'approve');
    await promise;
    vi.advanceTimersByTime(5000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('clearAll denies every pending approval', async () => {
    const a = reg.register({ tool: 'a', sessionId: 's' });
    const b = reg.register({ tool: 'b', sessionId: 's' });
    reg.clearAll();
    expect(reg.size).toBe(0);
    expect(await a.promise).toEqual({ decision: 'deny', timedOut: true });
    expect(await b.promise).toEqual({ decision: 'deny', timedOut: true });
  });
});
