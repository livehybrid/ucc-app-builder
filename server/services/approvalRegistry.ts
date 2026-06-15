/**
 * Server-side pending-approval registry for the SSE pause/resume handshake.
 *
 * When the agent is about to run an `ask`-policy tool that has NOT yet been
 * approved for the session, the SSE route:
 *   1. registers a pending approval here (→ a promise + an approvalId),
 *   2. emits an `approval_request` SSE frame to the browser, and
 *   3. AWAITs the promise.
 *
 * The browser renders an approval card and POSTs the user's decision to
 * `POST /api/ai/agent/approve { approvalId, decision }`, which calls
 * {@link ApprovalRegistry.resolve} to settle the awaiting promise — the agent loop
 * then resumes (running or skipping the tool).
 *
 * A timeout (default 180s) auto-settles the promise as `deny` and emits
 * `approval_timeout`, so a closed tab never wedges the loop forever.
 */

export type ApprovalDecision = 'approve' | 'approve_session' | 'deny';

/** What the awaiting agent loop receives once an approval settles. */
export interface ApprovalOutcome {
  decision: ApprovalDecision;
  /** True when the decision came from the timeout rather than the user. */
  timedOut: boolean;
}

interface PendingEntry {
  resolve: (outcome: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  tool: string;
  sessionId: string;
  onTimeout?: () => void;
}

export const DEFAULT_APPROVAL_TIMEOUT_MS = 180_000;

let counter = 0;
function nextId(): string {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  return `apr_${Date.now().toString(36)}_${counter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class ApprovalRegistry {
  private pending = new Map<string, PendingEntry>();

  /**
   * Register a pending approval and return its id + a promise that settles when
   * the user decides (or the timeout fires → `deny`). The `onTimeout` callback (if
   * given) runs when the timeout settles the promise, so the caller can emit an
   * `approval_timeout` SSE frame.
   */
  register(opts: {
    tool: string;
    sessionId: string;
    timeoutMs?: number;
    onTimeout?: () => void;
  }): { approvalId: string; promise: Promise<ApprovalOutcome> } {
    const approvalId = nextId();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;

    const promise = new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(approvalId);
        if (!entry) return;
        this.pending.delete(approvalId);
        entry.onTimeout?.();
        resolve({ decision: 'deny', timedOut: true });
      }, timeoutMs);
      // Don't keep the event loop alive solely for a pending approval.
      (timer as { unref?: () => void }).unref?.();

      this.pending.set(approvalId, {
        resolve,
        timer,
        tool: opts.tool,
        sessionId: opts.sessionId,
        onTimeout: opts.onTimeout,
      });
    });

    return { approvalId, promise };
  }

  /**
   * Settle a pending approval from a user decision. Returns true if an approval was
   * found and resolved, false if the id is unknown (already settled / timed out).
   */
  resolve(approvalId: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(approvalId);
    entry.resolve({ decision, timedOut: false });
    return true;
  }

  /** Is this approval still awaiting a decision? */
  has(approvalId: string): boolean {
    return this.pending.has(approvalId);
  }

  /** Number of approvals currently awaiting (mainly for tests). */
  get size(): number {
    return this.pending.size;
  }

  /** The ids of all approvals currently awaiting (mainly for tests/introspection). */
  pendingIds(): string[] {
    return [...this.pending.keys()];
  }

  /** Cancel & deny every pending approval (e.g. on shutdown / tests). */
  clearAll(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ decision: 'deny', timedOut: true });
    }
    this.pending.clear();
  }
}

/** Process-wide registry shared by the SSE route and the approve endpoint. */
export const approvalRegistry = new ApprovalRegistry();
