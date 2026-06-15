/**
 * Splunk MCP Server client (CONSUME side).
 *
 * Grounds add-on generation in the *live* Splunk instance: real indexes and
 * sourcetypes, SPL generation/validation via the `saia_*` tools, etc. Used by
 * the wizard to suggest real targets instead of asking the user to guess.
 *
 * Transport: streamable-HTTP, stateless (no Mcp-Session-Id, no initialize
 * handshake needed for one-shot tool calls). Auth: Bearer token.
 *
 * Config (env):
 *   SPLUNK_MCP_URL   e.g. https://host:8089/services/mcp
 *   SPLUNK_TOKEN     Bearer token scoped to /services/mcp
 *   SPLUNK_MCP_INSECURE=true to allow self-signed TLS (lab instances).
 */

export interface McpToolResult {
  raw: unknown;
  /** Decoded inner payload when the tool returns JSON-as-text in content[0].text. */
  data: unknown;
}

export interface IndexInfo {
  title: string;
  totalEventCount?: string;
  currentDBSizeMB?: string;
  disabled?: string;
}

export interface SourcetypeInfo {
  sourcetype: string;
  totalCount?: string;
  lastTimeIso?: string;
}

let idCounter = 1;

export class SplunkMcpService {
  private url?: string;
  private token?: string;

  constructor() {
    this.url = process.env.SPLUNK_MCP_URL;
    this.token = process.env.SPLUNK_TOKEN;
  }

  configured(): boolean {
    return !!this.url && !!this.token;
  }

  /** Low-level JSON-RPC tools/call against the Splunk MCP server. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    if (!this.configured()) {
      throw new Error(
        'Splunk MCP not configured. Set SPLUNK_MCP_URL and SPLUNK_TOKEN (see .hackathon-secrets.env).',
      );
    }

    // Allow self-signed TLS for lab instances without disabling it globally.
    const insecure = ['1', 'true', 'yes', 'on'].includes(
      (process.env.SPLUNK_MCP_INSECURE ?? '').toLowerCase(),
    );
    const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    if (insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    try {
      const body = {
        jsonrpc: '2.0',
        id: idCounter++,
        method: 'tools/call',
        params: { name, arguments: args },
      };
      const resp = await fetch(this.url!, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(body),
      });
      const text = await resp.text();
      // The server may answer as SSE ("data: {...}") or plain JSON.
      const jsonText = text
        .split('\n')
        .map((l) => (l.startsWith('data: ') ? l.slice(6) : l))
        .filter((l) => l.trim().startsWith('{'))
        .pop();
      if (!jsonText) throw new Error(`Unexpected MCP response: ${text.slice(0, 200)}`);
      const parsed = JSON.parse(jsonText) as {
        error?: { message?: string };
        result?: { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown };
      };
      if (parsed.error) throw new Error(`MCP error: ${parsed.error.message}`);

      // Tools return JSON-as-text in result.content[0].text; decode it.
      let data: unknown = parsed.result?.structuredContent ?? null;
      const textPart = parsed.result?.content?.find((c) => c.type === 'text')?.text;
      if (data === null && textPart) {
        try {
          data = JSON.parse(textPart);
        } catch {
          data = textPart;
        }
      }
      return { raw: parsed, data };
    } finally {
      if (insecure) {
        if (prevTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTls;
      }
    }
  }

  /** Real indexes on the instance, largest first, system indexes filtered out. */
  async getIndexes(): Promise<IndexInfo[]> {
    const { data } = await this.call('splunk_get_indexes', {});
    const results = (data as { results?: IndexInfo[] })?.results ?? [];
    return results
      .filter((i) => !i.title?.startsWith('_'))
      .sort((a, b) => Number(b.totalEventCount ?? 0) - Number(a.totalEventCount ?? 0));
  }

  /** Real sourcetypes for an index (or all data), for input/sourcetype suggestions. */
  async getSourcetypes(index?: string): Promise<SourcetypeInfo[]> {
    const args: Record<string, unknown> = { type: 'sourcetypes' };
    if (index) args.index = index;
    const { data } = await this.call('splunk_get_metadata', args);
    const results = (data as { results?: SourcetypeInfo[] })?.results ?? [];
    return results.sort((a, b) => Number(b.totalCount ?? 0) - Number(a.totalCount ?? 0));
  }

  /** Generate SPL from a natural-language description via the saia_generate_spl tool. */
  async generateSpl(question: string): Promise<unknown> {
    const { data } = await this.call('saia_generate_spl', { question });
    return data;
  }
}

export const splunkMcp = new SplunkMcpService();
