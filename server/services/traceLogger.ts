import fs from 'fs/promises';
import path from 'path';

/**
 * Local JSONL trace sink.
 *
 * Per the synthesis (docs/research/00-synthesis.md §3.7), observability ships
 * as local JSONL first; Langfuse is an optional pluggable sink.
 *
 * Each trace record is one line of JSON, appended to
 *   .ucc-agent/traces/<sessionId>.jsonl
 * relative to `TRACE_DIR` (default `process.cwd()/.ucc-agent/traces`).
 */

export interface TraceEvent {
  ts: string;
  sessionId: string;
  kind: 'tool_call' | 'tool_result' | 'llm_request' | 'llm_response' | 'error' | 'note';
  name?: string;
  durationMs?: number;
  tokens?: { input?: number; output?: number };
  payload?: Record<string, unknown>;
}

export class TraceLogger {
  private dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? process.env.TRACE_DIR ?? path.join(process.cwd(), '.ucc-agent/traces');
  }

  async log(event: Omit<TraceEvent, 'ts'>): Promise<void> {
    const record: TraceEvent = { ts: new Date().toISOString(), ...event };
    const file = path.join(this.dir, `${event.sessionId}.jsonl`);
    try {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.appendFile(file, JSON.stringify(record) + '\n', 'utf-8');
    } catch (err) {
      console.warn('[trace] failed to write', (err as Error).message);
    }
  }

  async read(sessionId: string, limit = 500): Promise<TraceEvent[]> {
    const file = path.join(this.dir, `${sessionId}.jsonl`);
    try {
      const text = await fs.readFile(file, 'utf-8');
      const lines = text.split('\n').filter(Boolean);
      return lines.slice(-limit).map((l) => JSON.parse(l) as TraceEvent);
    } catch {
      return [];
    }
  }

  async listSessions(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.dir);
      return entries
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => f.replace(/\.jsonl$/, ''))
        .sort();
    } catch {
      return [];
    }
  }
}

export const traceLogger = new TraceLogger();
