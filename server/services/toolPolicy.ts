/**
 * Tool-approval policy.
 *
 * Every agent-callable tool has a policy that decides whether the agent may run
 * it silently or must first get the user's blessing:
 *
 *   - `auto` — run with no prompt. Safe, local, in-process tools: VFS reads/writes,
 *              UCC validators, doc lookups, the build/inspect loop. They never touch
 *              anything outside the session sandbox.
 *   - `ask`  — EXTERNAL ACCESS. The first time the agent calls the tool in a session
 *              we pause and ask the user to approve. Once approved (for the session),
 *              subsequent calls run automatically — the approval is REMEMBERED.
 *   - `deny` — never run. Refused outright with a message fed back to the agent so it
 *              can adapt. (No tool defaults to `deny`; it exists for overrides.)
 *
 * The external-access tools default to `ask`: the live-Splunk MCP grounding tools
 * (`get_live_indexes`, `get_splunk_metadata`, `run_splunk_query`, `generate_spl`),
 * which query a real Splunk instance, plus any future deploy / external-fetch tool.
 *
 * --- AGENT_MCP_GROUNDING (repurposed) ---
 * Historically this env flag gated whether the grounding tools were *present* in the
 * toolset at all. It is now repurposed: the grounding tools are ALWAYS available, but
 *   - AGENT_MCP_GROUNDING ON  → grounding tools become `auto` (seamless, no prompt).
 *   - AGENT_MCP_GROUNDING OFF → grounding tools stay `ask` (available, but gated).
 *
 * --- AGENT_TOOL_POLICY (per-tool overrides) ---
 * A JSON object mapping tool name → policy, e.g.
 *   AGENT_TOOL_POLICY='{"run_splunk_query":"deny","write_file":"ask"}'
 * Individual tools can be forced to any policy. Invalid JSON / values are ignored.
 *
 * --- Per-request overrides ---
 * The Settings UI sends a `{ tool: policy }` map with each request (persisted to
 * localStorage). These are merged on top of env + defaults at resolve time, so the
 * user's choices win without a server restart.
 *
 * Precedence (lowest → highest):
 *   built-in default  <  AGENT_MCP_GROUNDING (grounding tools)  <  AGENT_TOOL_POLICY  <  per-request override
 */

export type ToolPolicy = 'auto' | 'ask' | 'deny';

/** The live-Splunk MCP grounding tools — external access, default `ask`. */
export const MCP_GROUNDING_TOOLS = [
  'get_live_indexes',
  'get_splunk_metadata',
  'run_splunk_query',
  'generate_spl',
] as const;

/**
 * Tools whose policy is `auto` by default: local/VFS primitives, UCC helpers, doc
 * lookups, and the in-process build/inspect loop. None of these reach outside the
 * session sandbox.
 */
export const AUTO_TOOLS = [
  'read_file',
  'write_file',
  'create_file',
  'apply_patch',
  'list_files',
  'todo_write',
  'record_decision',
  'read_memory',
  'write_memory',
  'validate_ucc_conformance',
  'get_stanza_spec',
  'list_stanzas',
  'get_splunk_sdk_reference',
  'get_splunklib_help',
  'consult_documentation',
  'generate_input_script',
  'add_config_entity',
  'build_and_inspect',
] as const;

/**
 * Tools that require approval on first use (external access). The MCP grounding
 * tools plus any deploy / external-fetch tool. These default to `ask`.
 */
export const ASK_TOOLS = [
  ...MCP_GROUNDING_TOOLS,
  // Browser/Docker integration tools reach outside the VFS sandbox.
  'install_to_splunk_docker',
  'browser_check',
] as const;

/** The built-in default policy for every known tool. Unknown tools default to `auto`. */
export const DEFAULT_TOOL_POLICY: Record<string, ToolPolicy> = (() => {
  const map: Record<string, ToolPolicy> = {};
  for (const t of AUTO_TOOLS) map[t] = 'auto';
  for (const t of ASK_TOOLS) map[t] = 'ask';
  return map;
})();

/** Fallback when a tool is not in the default map (e.g. a new local tool). */
export const FALLBACK_POLICY: ToolPolicy = 'auto';

function isPolicy(v: unknown): v is ToolPolicy {
  return v === 'auto' || v === 'ask' || v === 'deny';
}

/** Is live-Splunk MCP grounding set to "seamless" (auto) via AGENT_MCP_GROUNDING? */
export function mcpGroundingAuto(): boolean {
  const raw = (process.env.AGENT_MCP_GROUNDING ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

/** Parse AGENT_TOOL_POLICY (JSON map of tool → policy). Invalid input → {}. */
export function parseEnvToolPolicy(raw: string | undefined = process.env.AGENT_TOOL_POLICY): Record<string, ToolPolicy> {
  if (!raw || !raw.trim()) return {};
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    const out: Record<string, ToolPolicy> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (isPolicy(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Sanitise a per-request override map, keeping only valid policy values. */
export function sanitizeOverrides(input: unknown): Record<string, ToolPolicy> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, ToolPolicy> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof k === 'string' && k && isPolicy(v)) out[k] = v;
  }
  return out;
}

export interface ResolvePolicyOptions {
  /** Per-request overrides from the Settings UI (highest precedence). */
  overrides?: Record<string, ToolPolicy>;
  /** Override AGENT_MCP_GROUNDING (mainly for tests). Defaults to {@link mcpGroundingAuto}. */
  groundingAuto?: boolean;
  /** Override the AGENT_TOOL_POLICY env map (mainly for tests). */
  envPolicy?: Record<string, ToolPolicy>;
}

/**
 * Resolve the effective policy for a single tool, applying the full precedence
 * chain: built-in default < AGENT_MCP_GROUNDING (grounding tools) < AGENT_TOOL_POLICY
 * < per-request override.
 */
export function resolveToolPolicy(tool: string, opts: ResolvePolicyOptions = {}): ToolPolicy {
  const groundingAuto = opts.groundingAuto ?? mcpGroundingAuto();
  const envPolicy = opts.envPolicy ?? parseEnvToolPolicy();
  const overrides = opts.overrides ?? {};

  // 1) built-in default
  let policy: ToolPolicy = DEFAULT_TOOL_POLICY[tool] ?? FALLBACK_POLICY;

  // 2) AGENT_MCP_GROUNDING: when ON, grounding tools become seamless (auto).
  if (groundingAuto && (MCP_GROUNDING_TOOLS as readonly string[]).includes(tool)) {
    policy = 'auto';
  }

  // 3) AGENT_TOOL_POLICY per-tool env override
  if (isPolicy(envPolicy[tool])) policy = envPolicy[tool];

  // 4) per-request override (Settings UI) wins
  if (isPolicy(overrides[tool])) policy = overrides[tool];

  return policy;
}

/**
 * Resolve policies for a set of tool names at once (handy for the /api/ai/config
 * surface and tests). Returns a plain map.
 */
export function resolvePolicyMap(tools: string[], opts: ResolvePolicyOptions = {}): Record<string, ToolPolicy> {
  const out: Record<string, ToolPolicy> = {};
  for (const t of tools) out[t] = resolveToolPolicy(t, opts);
  return out;
}

/**
 * Per-session memory of tools the user has approved for the rest of the session.
 * Keyed by the agent run/session id. Once a tool is in a session's set, a policy of
 * `ask` is treated as already-granted for that session.
 */
export class SessionApprovalStore {
  private approved = new Map<string, Set<string>>();

  /** Record that `tool` is approved for the rest of `sessionId`. */
  approveForSession(sessionId: string, tool: string): void {
    let set = this.approved.get(sessionId);
    if (!set) {
      set = new Set<string>();
      this.approved.set(sessionId, set);
    }
    set.add(tool);
  }

  /** Has `tool` already been approved for `sessionId`? */
  isApproved(sessionId: string, tool: string): boolean {
    return this.approved.get(sessionId)?.has(tool) ?? false;
  }

  /** Drop all remembered approvals for one session (e.g. on a fresh run). */
  clearSession(sessionId: string): void {
    this.approved.delete(sessionId);
  }

  /** Drop everything (mainly for tests). */
  clearAll(): void {
    this.approved.clear();
  }
}

/** Process-wide session-approval store shared by the SSE route. */
export const sessionApprovals = new SessionApprovalStore();
