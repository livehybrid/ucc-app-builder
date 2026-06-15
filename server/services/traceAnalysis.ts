/**
 * Trace analysis for the admin prompt-doctor tool (scripts/prompt-doctor.ts).
 *
 * Pure, deterministic, no network: it reads the JSONL trace events the agent
 * writes to .ucc-agent/traces and turns them into a ranked "gap report" — the
 * recurring failure modes across past runs — split into:
 *   - prompt-addressable gaps (candidates for system-prompt edits), and
 *   - code/infra gaps (bugs/packaging issues a prompt edit can't fix).
 *
 * The LLM (in the script) only ever sees the prompt-addressable findings.
 */

export interface TraceEvent {
  ts: string;
  sessionId: string;
  kind: 'tool_call' | 'tool_result' | 'llm_request' | 'llm_response' | 'error' | 'note';
  name?: string;
  payload?: Record<string, unknown>;
}

export type Family = 'chat' | 'loop' | 'unknown';

export interface SessionSummary {
  sessionId: string;
  family: Family;
  model?: string;
  iterations?: number;
  hitIterationLimit?: boolean;
  stoppedNoProgress?: boolean;
  reachedClean?: boolean;
  /** Distinct error signatures seen in this session. */
  errorSignatures: string[];
  /** AppInspect/build checks left unresolved (loop runs). */
  unresolvedChecks: string[];
  /** Fix notes that repeated verbatim (ineffective fixes). */
  repeatedFixNotes: string[];
}

export type Category = 'prompt' | 'code' | 'infra';

export interface Finding {
  id: string;
  severity: 'high' | 'medium' | 'low';
  category: Category;
  title: string;
  detail: string;
  count: number;
  sessions: string[];
  /** Concrete guidance to add to the system prompt (prompt-addressable only). */
  promptSuggestion?: string;
}

export interface GapReport {
  sessionsAnalyzed: number;
  byFamily: Record<Family, number>;
  findings: Finding[];
}

/** Bucket a raw error string into a stable signature for aggregation. */
export function classifyError(message: string): string {
  const m = (message || '').toLowerCase();
  if (/role 'system' must follow|messages\.\d+: role 'system'/.test(m))
    return 'system-message-ordering';
  if (/stream stalled|did not respond within|provider hang/.test(m)) return 'llm-timeout';
  if (/rate limit|429|too many requests/.test(m)) return 'rate-limit';
  if (/context length|maximum context|too many tokens|413/.test(m)) return 'context-overflow';
  if (/401|403|invalid api key|unauthor/.test(m)) return 'auth';
  if (/ucc-gen build failed|build failed/.test(m)) return 'build-failed';
  if (/forbidden command|sandbox/.test(m)) return 'mcp-sandbox-forbidden';
  if (/\b400\b|invalid_request_error|provider returned error/.test(m)) return 'provider-400';
  return 'other';
}

const LOOP_NAME = /^loop\./;

/** Summarise a single session's events. */
export function summarizeSession(sessionId: string, events: TraceEvent[]): SessionSummary {
  const isLoop = events.some((e) => LOOP_NAME.test(e.name ?? ''));
  const family: Family = isLoop
    ? 'loop'
    : events.some((e) => ['planner', 'iteration', 'final', 'request'].includes(e.name ?? ''))
      ? 'chat'
      : 'unknown';

  const errorSignatures = new Set<string>();
  const unresolvedChecks = new Set<string>();
  const fixNoteCounts = new Map<string, number>();
  let model: string | undefined;
  let iterations: number | undefined;
  let hitIterationLimit: boolean | undefined;
  let stoppedNoProgress: boolean | undefined;
  let reachedClean: boolean | undefined;

  for (const e of events) {
    const p = e.payload ?? {};
    if (e.kind === 'error' || /error/i.test(e.name ?? '')) {
      const msg = String(p.error ?? p.message ?? '');
      if (msg) errorSignatures.add(classifyError(msg));
    }
    if (e.name === 'request' && typeof p.model === 'string') model = p.model;
    if (e.name === 'final') {
      if (typeof p.iterations === 'number') iterations = p.iterations;
      hitIterationLimit = Boolean(p.hitIterationLimit);
      stoppedNoProgress = Boolean(p.stoppedNoProgress);
    }
    // Loop signals.
    if (e.name === 'loop.done' && typeof p.clean === 'boolean') reachedClean = p.clean;
    if (e.name === 'loop.exhausted') {
      reachedClean = reachedClean ?? false;
      const msg = String(p.message ?? '');
      const checks = msg.match(/check_[a-z0-9_]+/gi) ?? [];
      checks.forEach((c) => unresolvedChecks.add(c));
    }
    if (e.name === 'loop.inspect') {
      // last inspect with a remaining failure names the check via actionable list
      const actionable = Array.isArray(p.actionable) ? (p.actionable as Array<{ check?: string }>) : [];
      actionable.forEach((a) => a.check && unresolvedChecks.add(a.check));
    }
    if (e.name === 'loop.fix' || e.name === 'fix') {
      const note = String(p.message ?? p.note ?? '');
      if (note) fixNoteCounts.set(note, (fixNoteCounts.get(note) ?? 0) + 1);
    }
    if (e.name === 'loop.build_error' || e.name === 'build_error') {
      const msg = String(p.message ?? '');
      if (msg) errorSignatures.add(classifyError(msg));
    }
  }

  // A loop that finished clean has no unresolved checks.
  if (reachedClean === true) unresolvedChecks.clear();

  return {
    sessionId,
    family,
    model,
    iterations,
    hitIterationLimit,
    stoppedNoProgress,
    reachedClean,
    errorSignatures: [...errorSignatures],
    unresolvedChecks: [...unresolvedChecks],
    repeatedFixNotes: [...fixNoteCounts.entries()].filter(([, n]) => n > 1).map(([note]) => note),
  };
}

interface FindingSpec {
  id: string;
  severity: Finding['severity'];
  category: Category;
  title: string;
  detail: (sessions: string[]) => string;
  promptSuggestion?: string;
}

// Map a session signal to a finding. Each entry decides whether a session
// "matches" and supplies the finding metadata.
const SIGNAL_FINDINGS: Array<{ match: (s: SessionSummary) => boolean; spec: FindingSpec }> = [
  {
    match: (s) => s.errorSignatures.includes('system-message-ordering'),
    spec: {
      id: 'system-message-ordering',
      severity: 'high',
      category: 'code',
      title: "Provider 400: a 'system' message in the wrong position",
      detail: (s) => `${s.length} run(s) failed because the request had a system message after the first turn (Anthropic-family providers reject this). This is a message-assembly CODE bug, not a prompt issue.`,
    },
  },
  {
    match: (s) => s.errorSignatures.includes('llm-timeout'),
    spec: {
      id: 'llm-timeout',
      severity: 'medium',
      category: 'infra',
      title: 'LLM connect/stream timeout',
      detail: (s) => `${s.length} run(s) hit a provider hang or stalled stream. Infra/provider issue; tune AGENT_LLM_*_TIMEOUT_MS or switch provider.`,
    },
  },
  {
    match: (s) => s.errorSignatures.includes('context-overflow'),
    spec: {
      id: 'context-overflow',
      severity: 'medium',
      category: 'prompt',
      title: 'Context-length overflow',
      detail: (s) => `${s.length} run(s) exceeded the model context window.`,
      promptSuggestion:
        'Instruct the agent to read files in targeted ranges rather than whole, summarise long tool outputs, and avoid re-reading unchanged files — to keep the context small.',
    },
  },
  {
    match: (s) => Boolean(s.hitIterationLimit),
    spec: {
      id: 'iteration-limit',
      severity: 'high',
      category: 'prompt',
      title: 'Runs hit the iteration cap without finishing',
      detail: (s) => `${s.length} run(s) ran out of iterations. Often the agent loops re-trying instead of finishing or stopping decisively.`,
      promptSuggestion:
        'Add explicit completion guidance: once build_and_inspect reports CLEAN, STOP and tell the user. If the same fix fails twice, do not repeat it — change approach or report the blocker to the user instead of looping.',
    },
  },
  {
    match: (s) => Boolean(s.stoppedNoProgress),
    spec: {
      id: 'no-progress',
      severity: 'medium',
      category: 'prompt',
      title: 'Agent repeated an identical failing action',
      detail: (s) => `${s.length} run(s) were stopped by the no-progress breaker (same action/result repeated).`,
      promptSuggestion:
        'Tell the agent: never repeat a tool call with identical arguments after it failed or changed nothing; diagnose the cause or ask the user.',
    },
  },
  {
    match: (s) => s.repeatedFixNotes.length > 0,
    spec: {
      id: 'repeated-ineffective-fix',
      severity: 'medium',
      category: 'prompt',
      title: 'The same fix was attempted repeatedly without resolving the error',
      detail: (s) => `${s.length} run(s) applied an identical fix note more than once. The model "claims" a fix that does not change the outcome.`,
      promptSuggestion:
        'Instruct the agent to verify a fix actually changed the failing output before re-running; if a fix does not move the error, try a materially different approach.',
    },
  },
  {
    match: (s) => s.unresolvedChecks.some((c) => /aarch64/i.test(c)),
    spec: {
      id: 'aarch64-unresolved',
      severity: 'high',
      category: 'code',
      title: 'AppInspect check_aarch64_compatibility left unresolved',
      detail: (s) => `${s.length} run(s) ended with a bundled non-aarch64 native binary. This is a PACKAGING issue (deterministic binary-strip handles it), not a prompt gap.`,
    },
  },
];

/** Aggregate session summaries into a ranked gap report. */
export function buildGapReport(summaries: SessionSummary[]): GapReport {
  const byFamily: Record<Family, number> = { chat: 0, loop: 0, unknown: 0 };
  for (const s of summaries) byFamily[s.family]++;

  const findings: Finding[] = [];
  for (const { match, spec } of SIGNAL_FINDINGS) {
    const hits = summaries.filter(match).map((s) => s.sessionId);
    if (hits.length === 0) continue;
    findings.push({
      id: spec.id,
      severity: spec.severity,
      category: spec.category,
      title: spec.title,
      detail: spec.detail(hits),
      count: hits.length,
      sessions: hits,
      promptSuggestion: spec.promptSuggestion,
    });
  }

  // Generic bucket for any other error signatures not covered above.
  const otherErrors = new Map<string, string[]>();
  for (const s of summaries) {
    for (const sig of s.errorSignatures) {
      if (findings.some((f) => f.id === sig)) continue;
      if (['system-message-ordering', 'llm-timeout', 'context-overflow'].includes(sig)) continue;
      otherErrors.set(sig, [...(otherErrors.get(sig) ?? []), s.sessionId]);
    }
  }
  for (const [sig, sessions] of otherErrors) {
    findings.push({
      id: `error-${sig}`,
      severity: 'low',
      category: sig === 'mcp-sandbox-forbidden' ? 'code' : 'infra',
      title: `Recurring error: ${sig}`,
      detail: `${sessions.length} run(s) hit a "${sig}" error.`,
      count: sessions.length,
      sessions,
    });
  }

  const sevRank = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || b.count - a.count);

  return { sessionsAnalyzed: summaries.length, byFamily, findings };
}

/** Convenience: parse JSONL text into events (skips malformed lines). */
export function parseTraceJsonl(text: string): TraceEvent[] {
  const out: TraceEvent[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as TraceEvent);
    } catch {
      /* skip */
    }
  }
  return out;
}
