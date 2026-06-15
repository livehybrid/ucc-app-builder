import { describe, it, expect } from 'vitest';
import {
  classifyError,
  summarizeSession,
  buildGapReport,
  parseTraceJsonl,
  TraceEvent,
} from './traceAnalysis';

const ev = (name: string, payload: Record<string, unknown>, kind: TraceEvent['kind'] = 'note'): TraceEvent => ({
  ts: '2026-06-14T00:00:00Z',
  sessionId: 's',
  kind,
  name,
  payload,
});

describe('classifyError', () => {
  it('buckets known provider errors', () => {
    expect(classifyError("messages.1: role 'system' must follow a 'user' message")).toBe(
      'system-message-ordering'
    );
    expect(classifyError('LLM stream stalled — no data for 120s')).toBe('llm-timeout');
    expect(classifyError('ucc-gen build failed with code 1')).toBe('build-failed');
    expect(classifyError('Forbidden command found: rest')).toBe('mcp-sandbox-forbidden');
    expect(classifyError('something weird')).toBe('other');
  });
});

describe('summarizeSession', () => {
  it('summarises a chat run that hit the iteration limit', () => {
    const s = summarizeSession('chat-1', [
      ev('request', { model: 'anthropic/claude-opus-4.8' }),
      ev('iteration', { index: 1 }),
      ev('final', { iterations: 15, hitIterationLimit: true, stoppedNoProgress: false }),
    ]);
    expect(s.family).toBe('chat');
    expect(s.model).toContain('opus');
    expect(s.hitIterationLimit).toBe(true);
  });

  it('captures a system-message-ordering 400 from an agent_error', () => {
    const s = summarizeSession('chat-2', [
      ev('agent_error', { error: "Provider 400: messages.1: role 'system' must follow a 'user' message" }, 'error'),
      ev('final', { iterations: 1 }),
    ]);
    expect(s.errorSignatures).toContain('system-message-ordering');
  });

  it('summarises a loop run that exhausted on aarch64 and flags repeated fixes', () => {
    const s = summarizeSession('loop-1', [
      ev('loop.start', { iteration: 0 }),
      ev('loop.build_error', { iteration: 1, message: 'Build failed: ucc-gen build failed with code 1' }),
      ev('loop.fix', { iteration: 1, message: 'LLM build-error fix: tweaked manifest' }),
      ev('loop.fix', { iteration: 2, message: 'LLM build-error fix: tweaked manifest' }),
      ev('loop.inspect', { iteration: 3, actionable: [{ check: 'check_aarch64_compatibility' }] }),
      ev('loop.exhausted', { iteration: 4, message: 'Reached maxIterations with 1 unresolved check(s). check_aarch64_compatibility' }),
      ev('loop.done', { iteration: 4, clean: false }),
    ]);
    expect(s.family).toBe('loop');
    expect(s.reachedClean).toBe(false);
    expect(s.unresolvedChecks).toContain('check_aarch64_compatibility');
    expect(s.repeatedFixNotes).toHaveLength(1);
  });

  it('clears unresolved checks when the loop finished clean', () => {
    const s = summarizeSession('loop-2', [
      ev('loop.inspect', { actionable: [{ check: 'check_x' }] }),
      ev('loop.done', { clean: true }),
    ]);
    expect(s.reachedClean).toBe(true);
    expect(s.unresolvedChecks).toEqual([]);
  });
});

describe('buildGapReport', () => {
  it('ranks findings and tags prompt vs code vs infra', () => {
    const summaries = [
      summarizeSession('a', [ev('final', { hitIterationLimit: true })]),
      summarizeSession('b', [ev('final', { hitIterationLimit: true })]),
      summarizeSession('c', [ev('agent_error', { error: "role 'system' must follow a 'user' message" }, 'error')]),
      summarizeSession('d', [ev('loop.exhausted', { message: 'check_aarch64_compatibility' }), ev('loop.done', { clean: false })]),
    ];
    const report = buildGapReport(summaries);

    const iter = report.findings.find((f) => f.id === 'iteration-limit')!;
    expect(iter.category).toBe('prompt');
    expect(iter.count).toBe(2);
    expect(iter.promptSuggestion).toBeTruthy();

    const sys = report.findings.find((f) => f.id === 'system-message-ordering')!;
    expect(sys.category).toBe('code');
    expect(sys.promptSuggestion).toBeUndefined();

    const arm = report.findings.find((f) => f.id === 'aarch64-unresolved')!;
    expect(arm.category).toBe('code');

    // High severity sorts before low.
    expect(report.findings[0].severity).toBe('high');
    // Prompt-addressable subset exists.
    expect(report.findings.some((f) => f.category === 'prompt' && f.promptSuggestion)).toBe(true);
  });

  it('parses JSONL, skipping malformed lines', () => {
    const events = parseTraceJsonl('{"ts":"t","sessionId":"s","kind":"note"}\nnot json\n\n{"ts":"t","sessionId":"s","kind":"error"}');
    expect(events).toHaveLength(2);
  });
});
