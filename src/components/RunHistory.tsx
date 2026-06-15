/**
 * Run History - read-only viewer for durable Splunk Agent SDK (splunklib.ai) chat traces.
 *
 * The native Splunk app persists every agent run (assistant / tool_call / tool_result
 * events + metadata) to the ucc_agent_traces KV collection, so a run outlives the per-job
 * file's TTL. This panel lists past runs (/agent_traces) and renders one in full
 * (/agent_trace) - for review, debugging, or just resuming context. Splunk-app only (it
 * uses the loader's same-origin REST helper).
 */
import { useCallback, useEffect, useState } from 'react';
import Modal from '@splunk/react-ui/Modal';
import Button from '@splunk/react-ui/Button';
import Message from '@splunk/react-ui/Message';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';

type SplunkFetch = (path: string, init?: RequestInit) => Promise<Response>;

function splunkFetch(): SplunkFetch | undefined {
  return (window as unknown as { __UCC_SPLUNK_FETCH__?: SplunkFetch }).__UCC_SPLUNK_FETCH__;
}

interface TraceRow {
  job_id: string;
  created_at?: number;
  model?: string;
  provider?: string;
  status?: string;
  prompt?: string;
  step_count?: number;
  event_count?: number;
}
interface TraceEvent {
  event: string;
  content?: string;
  name?: string;
  id?: string;
  args?: unknown;
  result?: unknown;
  answer?: string;
  error?: string;
}
interface TraceDoc extends TraceRow {
  answer?: string;
  error?: string;
  events: TraceEvent[];
}

interface Props {
  open: boolean;
  onClose: () => void;
}

async function call<T>(path: string, body: unknown): Promise<T> {
  const fn = splunkFetch();
  if (!fn) throw new Error('Run history requires the native Splunk app.');
  const res = await fn(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok && res.status !== 404) throw new Error(String(data.error || `HTTP ${res.status}`));
  return data as T;
}

function when(ts?: number): string {
  if (!ts) return '';
  try {
    return new Date(ts * 1000).toLocaleString();
  } catch {
    return '';
  }
}

const STATUS_COLOR: Record<string, string> = { done: '#53a051', error: '#dc4e41', cancelled: '#f8be34' };

function preview(s?: string, n = 80): string {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t || '(no prompt)';
}

export function RunHistory({ open, onClose }: Props) {
  const [rows, setRows] = useState<TraceRow[]>([]);
  const [selected, setSelected] = useState<TraceDoc | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await call<{ traces?: TraceRow[] }>('/agent_traces', {});
      const traces = Array.isArray(d.traces) ? d.traces.slice() : [];
      // Most recent run first.
      traces.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
      setRows(traces);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setSelected(null);
      void refresh();
    }
  }, [open, refresh]);

  const openTrace = async (jobId: string) => {
    setLoading(true);
    setError(null);
    try {
      const d = await call<{ found?: boolean; trace?: TraceDoc }>('/agent_trace', { job_id: jobId });
      if (d.found === false || !d.trace) {
        setError('That run is no longer available.');
      } else {
        setSelected(d.trace);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal open={open} onRequestClose={onClose} style={{ width: 760, maxWidth: '94%' }} returnFocus={() => {}}>
      <Modal.Header title={selected ? 'Run trace' : 'Run history'} />
      <Modal.Body>
        {error && (
          <Message type="error" style={{ marginBottom: 12 }}>
            {error}
          </Message>
        )}

        {!selected ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ color: '#9b9ea3', fontSize: '0.85rem' }}>
                Past Splunk Agent SDK runs (newest first).
              </span>
              <Button appearance="default" onClick={() => void refresh()} disabled={loading} label="Refresh" />
            </div>
            {loading ? (
              <WaitSpinner size="medium" />
            ) : rows.length === 0 ? (
              <p style={{ color: '#9b9ea3' }}>No runs recorded yet - start a chat with the Splunk Agent SDK.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {rows.map((r) => (
                  <button
                    key={r.job_id}
                    onClick={() => void openTrace(r.job_id)}
                    style={{
                      textAlign: 'left',
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid rgba(255,255,255,0.12)',
                      borderRadius: 6,
                      padding: '8px 12px',
                      cursor: 'pointer',
                      color: 'inherit',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <span style={{ fontWeight: 600 }}>{preview(r.prompt)}</span>
                      <span style={{ color: STATUS_COLOR[r.status || ''] || '#9b9ea3', fontSize: '0.8rem' }}>
                        {r.status || '-'}
                      </span>
                    </div>
                    <div style={{ fontSize: '0.78rem', color: '#9b9ea3', marginTop: 2 }}>
                      {r.model || '-'} · {r.step_count ?? 0} steps · {r.event_count ?? 0} events
                      {r.created_at ? ` · ${when(r.created_at)}` : ''}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <Button appearance="default" onClick={() => setSelected(null)} label="← Back to list" />
            <div style={{ margin: '10px 0', fontSize: '0.8rem', color: '#9b9ea3' }}>
              <span style={{ color: STATUS_COLOR[selected.status || ''] || '#9b9ea3' }}>{selected.status}</span>
              {' · '}
              {selected.model || '-'} · {selected.step_count ?? 0} steps · {when(selected.created_at)}
            </div>
            {selected.prompt && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: '0.78rem', color: '#9b9ea3' }}>Prompt</div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{selected.prompt}</div>
              </div>
            )}
            <div style={{ maxHeight: 360, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {selected.events.map((ev, i) => (
                <TraceEventRow key={i} ev={ev} />
              ))}
            </div>
          </>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button appearance="default" onClick={onClose} label="Close" />
      </Modal.Footer>
    </Modal>
  );
}

function asText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function TraceEventRow({ ev }: { ev: TraceEvent }) {
  const base = { padding: '6px 10px', borderRadius: 6, fontSize: '0.82rem', whiteSpace: 'pre-wrap' as const };
  if (ev.event === 'assistant') {
    return <div style={{ ...base, background: 'rgba(120,150,255,0.10)' }}>{ev.content}</div>;
  }
  if (ev.event === 'tool_call') {
    return (
      <div style={{ ...base, background: 'rgba(255,255,255,0.05)', fontFamily: 'monospace' }}>
        🔧 {ev.name}
        {ev.args ? `(${asText(ev.args)})` : '()'}
      </div>
    );
  }
  if (ev.event === 'tool_result') {
    return (
      <div style={{ ...base, background: 'rgba(255,255,255,0.03)', color: '#9b9ea3', fontFamily: 'monospace' }}>
        → {asText(ev.result ?? ev.content)}
      </div>
    );
  }
  if (ev.event === 'done') {
    return <div style={{ ...base, background: 'rgba(83,160,81,0.12)' }}>✓ {ev.answer || 'done'}</div>;
  }
  if (ev.event === 'error') {
    return <div style={{ ...base, background: 'rgba(220,78,65,0.12)' }}>⚠ {ev.error || 'error'}</div>;
  }
  return <div style={base}>{asText(ev)}</div>;
}
