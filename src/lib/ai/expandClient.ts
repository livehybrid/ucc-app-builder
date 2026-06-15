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
  if (!res.ok) {
    let detail = '';
    try {
      const e = (await res.json()) as { error?: { message?: string } | string };
      detail = typeof e?.error === 'string' ? e.error : e?.error?.message || '';
    } catch {
      /* ignore */
    }
    throw new Error(`Expansion request failed (${res.status})${detail ? `: ${detail}` : ''}.`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string; reasoning?: string }; finish_reason?: string }>;
    error?: { message?: string } | string;
  };
  const choice = data?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    const errMsg = typeof data?.error === 'string' ? data.error : data?.error?.message;
    // A reasoning model can spend its whole budget on `reasoning` and return empty
    // `content` - name that case so the user knows to pick a non-reasoning chat model.
    const reasoned = !!choice?.message?.reasoning || choice?.finish_reason === 'length';
    throw new Error(
      errMsg
        ? `the model returned an error: ${errMsg}`
        : reasoned
          ? `the model "${opts.model || 'default'}" returned only reasoning and no content - ` +
            `pick a non-reasoning chat model (e.g. anthropic/claude-sonnet-4.6) in ` +
            `Configuration → AI Provider.`
          : `the model "${opts.model || 'default'}" returned an empty response.`
    );
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
 * Never throws - when Splunk grounding isn't configured the endpoints 404 and we expand
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
