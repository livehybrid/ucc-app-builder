import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveToolPolicy,
  resolvePolicyMap,
  parseEnvToolPolicy,
  sanitizeOverrides,
  mcpGroundingAuto,
  DEFAULT_TOOL_POLICY,
  MCP_GROUNDING_TOOLS,
  AUTO_TOOLS,
  ASK_TOOLS,
  SessionApprovalStore,
} from './toolPolicy.js';

describe('toolPolicy — defaults', () => {
  it('local/VFS + build tools default to auto', () => {
    for (const t of AUTO_TOOLS) {
      expect(resolveToolPolicy(t, { groundingAuto: false, envPolicy: {} })).toBe('auto');
    }
    // build_and_inspect specifically is auto.
    expect(DEFAULT_TOOL_POLICY['build_and_inspect']).toBe('auto');
  });

  it('external-access tools default to ask', () => {
    for (const t of ASK_TOOLS) {
      expect(resolveToolPolicy(t, { groundingAuto: false, envPolicy: {} })).toBe('ask');
    }
    for (const t of MCP_GROUNDING_TOOLS) {
      expect(resolveToolPolicy(t, { groundingAuto: false, envPolicy: {} })).toBe('ask');
    }
  });

  it('unknown tools fall back to auto', () => {
    expect(resolveToolPolicy('some_new_local_tool', { groundingAuto: false, envPolicy: {} })).toBe('auto');
  });
});

describe('toolPolicy — AGENT_MCP_GROUNDING repurposed (ask vs auto)', () => {
  it('grounding tools become auto when grounding is ON (seamless)', () => {
    for (const t of MCP_GROUNDING_TOOLS) {
      expect(resolveToolPolicy(t, { groundingAuto: true, envPolicy: {} })).toBe('auto');
    }
  });

  it('grounding tools stay ask when grounding is OFF (available but gated)', () => {
    for (const t of MCP_GROUNDING_TOOLS) {
      expect(resolveToolPolicy(t, { groundingAuto: false, envPolicy: {} })).toBe('ask');
    }
  });

  it('grounding flag does not affect non-grounding ask tools', () => {
    expect(resolveToolPolicy('install_to_splunk_docker', { groundingAuto: true, envPolicy: {} })).toBe('ask');
  });

  it('mcpGroundingAuto() reads AGENT_MCP_GROUNDING truthiness', () => {
    const prev = process.env.AGENT_MCP_GROUNDING;
    try {
      delete process.env.AGENT_MCP_GROUNDING;
      expect(mcpGroundingAuto()).toBe(false);
      for (const v of ['0', 'false', 'off', 'no', '']) {
        process.env.AGENT_MCP_GROUNDING = v;
        expect(mcpGroundingAuto()).toBe(false);
      }
      for (const v of ['1', 'true', 'on', 'YES']) {
        process.env.AGENT_MCP_GROUNDING = v;
        expect(mcpGroundingAuto()).toBe(true);
      }
    } finally {
      if (prev === undefined) delete process.env.AGENT_MCP_GROUNDING;
      else process.env.AGENT_MCP_GROUNDING = prev;
    }
  });
});

describe('toolPolicy — AGENT_TOOL_POLICY env override', () => {
  it('parses a valid JSON map and ignores invalid values', () => {
    const parsed = parseEnvToolPolicy('{"run_splunk_query":"deny","write_file":"ask","x":"bogus","y":123}');
    expect(parsed).toEqual({ run_splunk_query: 'deny', write_file: 'ask' });
  });

  it('returns {} for invalid / empty JSON', () => {
    expect(parseEnvToolPolicy('')).toEqual({});
    expect(parseEnvToolPolicy('not json')).toEqual({});
    expect(parseEnvToolPolicy('[1,2,3]')).toEqual({});
    expect(parseEnvToolPolicy(undefined)).toEqual({});
  });

  it('env policy overrides the built-in default', () => {
    expect(
      resolveToolPolicy('write_file', { groundingAuto: false, envPolicy: { write_file: 'ask' } }),
    ).toBe('ask');
    expect(
      resolveToolPolicy('run_splunk_query', { groundingAuto: true, envPolicy: { run_splunk_query: 'deny' } }),
    ).toBe('deny'); // env beats the grounding=auto promotion
  });
});

describe('toolPolicy — per-request overrides win', () => {
  it('override beats env and default', () => {
    expect(
      resolveToolPolicy('write_file', {
        groundingAuto: false,
        envPolicy: { write_file: 'ask' },
        overrides: { write_file: 'deny' },
      }),
    ).toBe('deny');
  });

  it('sanitizeOverrides drops invalid entries', () => {
    expect(sanitizeOverrides({ a: 'auto', b: 'ask', c: 'deny', d: 'nope', e: 5 })).toEqual({
      a: 'auto',
      b: 'ask',
      c: 'deny',
    });
    expect(sanitizeOverrides(null)).toEqual({});
    expect(sanitizeOverrides([1, 2])).toEqual({});
  });
});

describe('resolvePolicyMap', () => {
  it('resolves a set of tools at once', () => {
    const map = resolvePolicyMap(['write_file', 'run_splunk_query'], { groundingAuto: false, envPolicy: {} });
    expect(map).toEqual({ write_file: 'auto', run_splunk_query: 'ask' });
  });
});

describe('SessionApprovalStore — remembers approvals per session', () => {
  let store: SessionApprovalStore;
  beforeEach(() => {
    store = new SessionApprovalStore();
  });

  it('approve_session makes subsequent calls auto', () => {
    expect(store.isApproved('s1', 'run_splunk_query')).toBe(false);
    store.approveForSession('s1', 'run_splunk_query');
    expect(store.isApproved('s1', 'run_splunk_query')).toBe(true);
    // Different tool / session unaffected.
    expect(store.isApproved('s1', 'get_live_indexes')).toBe(false);
    expect(store.isApproved('s2', 'run_splunk_query')).toBe(false);
  });

  it('clearSession forgets one session only', () => {
    store.approveForSession('s1', 'run_splunk_query');
    store.approveForSession('s2', 'run_splunk_query');
    store.clearSession('s1');
    expect(store.isApproved('s1', 'run_splunk_query')).toBe(false);
    expect(store.isApproved('s2', 'run_splunk_query')).toBe(true);
  });
});
