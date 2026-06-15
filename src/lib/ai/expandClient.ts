/**
 * Browser-side driver for the Expert Expansion stage. Runs ONE structured LLM call to turn
 * a request into a {@link UccSpec}, then the UI gates it for review before the build. Works
 * for both agent paths: the call goes to /api/ai/chat (server key injected by the Splunk
 * proxy / Node engine) when server-managed, or straight to OpenRouter with the user's key.
 */
import { fetchWithRetry } from './retry';
import {
  type UccSpec,
  type ExpansionGrounding,
  expansionSystemPrompt,
  expansionUserPrompt,
  parseSpec,
} from './expansion';

export interface ExpandOptions {
  request: string;
  model: string;
  /** server-managed (proxy/engine holds the key) → /api/ai/chat; else direct to OpenRouter */
  serverManaged: boolean;
  apiKey?: string;
  grounding?: ExpansionGrounding;
  signal?: AbortSignal;
}

export async function expandRequest(opts: ExpandOptions): Promise<UccSpec> {
  const body = JSON.stringify({
    model: opts.model,
    messages: [
      { role: 'system', content: expansionSystemPrompt() },
      { role: 'user', content: expansionUserPrompt(opts.request, opts.grounding) },
    ],
    stream: false,
    max_tokens: 4096,
    // Low temperature: this is structured extraction, not creative writing.
    temperature: 0.2,
  });

  const url = opts.serverManaged
    ? '/api/ai/chat'
    : 'https://openrouter.ai/api/v1/chat/completions';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!opts.serverManaged) {
    headers['Authorization'] = `Bearer ${opts.apiKey ?? ''}`;
    headers['HTTP-Referer'] = 'https://splunk.engineer';
    headers['X-Title'] = 'UCCBuilder';
  }

  const res = await fetchWithRetry(url, { method: 'POST', headers, body, signal: opts.signal });
  if (!res.ok) throw new Error(`Expansion request failed (${res.status}).`);
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('Expansion returned an empty response.');
  }
  return parseSpec(content);
}

function namesFrom(payload: unknown, key: string): string[] {
  const arr = Array.isArray(payload)
    ? payload
    : (payload as Record<string, unknown>)?.[key];
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => (typeof x === 'string' ? x : (x as Record<string, unknown>)?.name))
    .filter((x): x is string => typeof x === 'string' && x.length > 0);
}

/**
 * Best-effort live grounding (indexes + sourcetypes) to make the spec schema-accurate.
 * Never throws — when Splunk grounding isn't configured the endpoints 404 and we expand
 * ungrounded (the spec is flagged grounded=false).
 */
export async function fetchGrounding(signal?: AbortSignal): Promise<ExpansionGrounding> {
  const out: ExpansionGrounding = {};
  try {
    const r = await fetch('/api/splunk/indexes', { signal });
    if (r.ok) out.indexes = namesFrom(await r.json(), 'indexes');
  } catch {
    /* grounding is optional */
  }
  try {
    const r = await fetch('/api/splunk/sourcetypes', { signal });
    if (r.ok) out.sourcetypes = namesFrom(await r.json(), 'sourcetypes');
  } catch {
    /* grounding is optional */
  }
  return out;
}
