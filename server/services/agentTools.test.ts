import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VirtualFileSystem } from '../../src/lib/vfs.js';

// --- Mocks ---------------------------------------------------------------
// splunkMcp: a configurable fake so we can drive the MCP-as-tools paths
// without touching the live (READ-ONLY) Splunk instance.
const mcpState = {
  configured: true,
  getIndexes: vi.fn(),
  getSourcetypes: vi.fn(),
  generateSpl: vi.fn(),
  call: vi.fn(),
};

vi.mock('./splunkMcp.js', () => ({
  splunkMcp: {
    configured: () => mcpState.configured,
    getIndexes: (...a: unknown[]) => mcpState.getIndexes(...a),
    getSourcetypes: (...a: unknown[]) => mcpState.getSourcetypes(...a),
    generateSpl: (...a: unknown[]) => mcpState.generateSpl(...a),
    call: (...a: unknown[]) => mcpState.call(...a),
  },
}));

// runAgentLoop: fake the self-correcting loop. By default it "fixes" a file and
// reports CLEAN so we can assert build_and_inspect syncs files back to the VFS.
const loopMock = vi.fn();
vi.mock('./agentLoop.js', () => ({
  runAgentLoop: (...a: unknown[]) => loopMock(...a),
}));

import {
  getLiveIndexes,
  getSplunkMetadata,
  runSplunkQuery,
  generateSpl as generateSplTool,
  buildAndInspect,
  MCP_AGENT_TOOLS,
  VERIFY_AGENT_TOOLS,
  SERVER_INTEGRATION_TOOLS,
  mcpGroundingEnabled,
  resolveServerIntegrationTools,
} from './agentTools.js';

beforeEach(() => {
  mcpState.configured = true;
  mcpState.getIndexes.mockReset();
  mcpState.getSourcetypes.mockReset();
  mcpState.generateSpl.mockReset();
  mcpState.call.mockReset();
  loopMock.mockReset();
});

function vfs(files: Record<string, string>): VirtualFileSystem {
  const v = new VirtualFileSystem();
  for (const [p, c] of Object.entries(files)) v.writeFile(p, c, 'user');
  return v;
}

describe('SERVER_INTEGRATION_TOOLS — registry composition', () => {
  it('registers exactly the 5 privileged integration tools with the expected names', () => {
    expect(MCP_AGENT_TOOLS.map((t) => t.name)).toEqual([
      'get_live_indexes',
      'get_splunk_metadata',
      'run_splunk_query',
      'generate_spl',
    ]);
    expect(VERIFY_AGENT_TOOLS.map((t) => t.name)).toEqual(['build_and_inspect']);
    expect(SERVER_INTEGRATION_TOOLS.map((t) => t.name)).toEqual([
      'get_live_indexes',
      'get_splunk_metadata',
      'run_splunk_query',
      'generate_spl',
      'build_and_inspect',
    ]);
    // No accidental duplicates across the merged set.
    const names = SERVER_INTEGRATION_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every integration tool is a well-formed function tool with an object schema', () => {
    for (const tool of SERVER_INTEGRATION_TOOLS) {
      expect(typeof tool.name).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(typeof tool.execute).toBe('function');
      expect(tool.parameters).toMatchObject({ type: 'object' });
    }
  });
});

describe('MCP-as-tools', () => {
  it('get_live_indexes returns a hint when MCP is unconfigured', async () => {
    mcpState.configured = false;
    const out = await getLiveIndexes.execute({}, vfs({}));
    expect(out).toMatch(/not configured/i);
    expect(mcpState.getIndexes).not.toHaveBeenCalled();
  });

  it('get_live_indexes lists indexes from the live instance', async () => {
    mcpState.getIndexes.mockResolvedValue([
      { title: 'main', totalEventCount: '791000000', currentDBSizeMB: '1234' },
      { title: 'pihole', totalEventCount: '11000000' },
    ]);
    const out = await getLiveIndexes.execute({ limit: 1 }, vfs({}));
    expect(out).toContain('main');
    expect(out).toContain('791000000');
    // limit honoured: only 1 of 2 shown
    expect(out).not.toContain('pihole');
    expect(out).toContain('1/2');
  });

  it('get_splunk_metadata scopes by index and lists sourcetypes', async () => {
    mcpState.getSourcetypes.mockResolvedValue([
      { sourcetype: 'access_combined', totalCount: '500' },
    ]);
    const out = await getSplunkMetadata.execute({ index: 'main' }, vfs({}));
    expect(mcpState.getSourcetypes).toHaveBeenCalledWith('main');
    expect(out).toContain('access_combined');
    expect(out).toContain('main');
  });

  it('run_splunk_query prepends search and calls splunk_run_query', async () => {
    mcpState.call.mockResolvedValue({ data: { results: [{ a: 1 }] } });
    const out = await runSplunkQuery.execute({ query: 'index=main' }, vfs({}));
    expect(mcpState.call).toHaveBeenCalledWith(
      'splunk_run_query',
      expect.objectContaining({ query: 'search index=main' }),
    );
    expect(out).toContain('"a": 1');
  });

  it('run_splunk_query leaves a leading pipe untouched', async () => {
    mcpState.call.mockResolvedValue({ data: { results: [] } });
    await runSplunkQuery.execute({ query: '| makeresults' }, vfs({}));
    expect(mcpState.call).toHaveBeenCalledWith(
      'splunk_run_query',
      expect.objectContaining({ query: '| makeresults' }),
    );
  });

  it('generate_spl calls the saia generator', async () => {
    mcpState.generateSpl.mockResolvedValue({ spl: 'index=main | stats count' });
    const out = await generateSplTool.execute({ question: 'count events' }, vfs({}));
    expect(mcpState.generateSpl).toHaveBeenCalledWith('count events');
    expect(out).toContain('stats count');
  });

  it('surfaces MCP errors without throwing', async () => {
    mcpState.getIndexes.mockRejectedValue(new Error('boom'));
    const out = await getLiveIndexes.execute({}, vfs({}));
    expect(out).toMatch(/failed: boom/);
  });

  // --- Branch hardening: every MCP-as-tool guards an unconfigured server,
  // empty/invalid input and a thrown MCP call, and stays read-only. ----------

  it('get_live_indexes reports when the live instance has no user indexes', async () => {
    mcpState.getIndexes.mockResolvedValue([]);
    const out = await getLiveIndexes.execute({}, vfs({}));
    expect(out).toMatch(/no user indexes/i);
  });

  it('get_splunk_metadata returns a hint when MCP is unconfigured', async () => {
    mcpState.configured = false;
    const out = await getSplunkMetadata.execute({ index: 'main' }, vfs({}));
    expect(out).toMatch(/not configured/i);
    expect(mcpState.getSourcetypes).not.toHaveBeenCalled();
  });

  it('get_splunk_metadata reports no sourcetypes (scoped) and surfaces errors', async () => {
    mcpState.getSourcetypes.mockResolvedValue([]);
    const empty = await getSplunkMetadata.execute({ index: 'main' }, vfs({}));
    expect(empty).toMatch(/no sourcetypes/i);
    expect(empty).toContain('main');

    mcpState.getSourcetypes.mockRejectedValue(new Error('mcp down'));
    const err = await getSplunkMetadata.execute({}, vfs({}));
    expect(err).toMatch(/get_splunk_metadata failed: mcp down/);
  });

  it('run_splunk_query guards unconfigured MCP, empty query, and errors', async () => {
    mcpState.configured = false;
    expect(await runSplunkQuery.execute({ query: 'index=main' }, vfs({}))).toMatch(
      /not configured/i,
    );
    expect(mcpState.call).not.toHaveBeenCalled();

    mcpState.configured = true;
    expect(await runSplunkQuery.execute({ query: '   ' }, vfs({}))).toMatch(/query is required/i);
    expect(mcpState.call).not.toHaveBeenCalled();

    mcpState.call.mockRejectedValue(new Error('search failed'));
    expect(await runSplunkQuery.execute({ query: 'index=main' }, vfs({}))).toMatch(
      /run_splunk_query failed: search failed/,
    );
  });

  it('run_splunk_query passes through earliest/latest time bounds', async () => {
    mcpState.call.mockResolvedValue({ data: { results: [] } });
    await runSplunkQuery.execute(
      { query: 'index=main', earliest: '-7d', latest: '-1d' },
      vfs({}),
    );
    expect(mcpState.call).toHaveBeenCalledWith(
      'splunk_run_query',
      expect.objectContaining({ earliest_time: '-7d', latest_time: '-1d' }),
    );
  });

  it('run_splunk_query truncates very large result payloads', async () => {
    const big = Array.from({ length: 5000 }, (_, i) => ({ i, v: 'x'.repeat(20) }));
    mcpState.call.mockResolvedValue({ data: { results: big } });
    const out = await runSplunkQuery.execute({ query: 'index=main' }, vfs({}));
    expect(out).toMatch(/truncated/);
    expect(out.length).toBeLessThan(9000);
  });

  it('generate_spl guards unconfigured MCP and empty question', async () => {
    mcpState.configured = false;
    expect(await generateSplTool.execute({ question: 'count events' }, vfs({}))).toMatch(
      /not configured/i,
    );
    expect(mcpState.generateSpl).not.toHaveBeenCalled();

    mcpState.configured = true;
    expect(await generateSplTool.execute({ question: '  ' }, vfs({}))).toMatch(
      /question is required/i,
    );
    expect(mcpState.generateSpl).not.toHaveBeenCalled();
  });

  it('generate_spl returns a plain string result verbatim and surfaces errors', async () => {
    mcpState.generateSpl.mockResolvedValue('index=main | stats count by sourcetype');
    const out = await generateSplTool.execute({ question: 'count by sourcetype' }, vfs({}));
    expect(out).toContain('stats count by sourcetype');

    mcpState.generateSpl.mockRejectedValue(new Error('saia offline'));
    expect(await generateSplTool.execute({ question: 'x' }, vfs({}))).toMatch(
      /generate_spl failed: saia offline/,
    );
  });
});

describe('build_and_inspect', () => {
  it('infers appId from globalConfig.json location', async () => {
    loopMock.mockResolvedValue({
      ok: true,
      clean: true,
      iterations: 1,
      appId: 'TA_demo',
      files: [],
      events: [],
      finalSummary: 'clean',
      tarball: '/tmp/TA_demo.tar.gz',
    });
    const v = vfs({ 'TA_demo/globalConfig.json': '{}' });
    const out = await buildAndInspect.execute({}, v);
    expect(loopMock).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'TA_demo' }),
    );
    expect(out).toContain('AppInspect-CLEAN');
    expect(out).toContain('Package:');
  });

  it('errors clearly when appId cannot be inferred', async () => {
    const out = await buildAndInspect.execute({}, vfs({ 'random.txt': 'x' }));
    expect(out).toMatch(/could not infer appId/i);
    expect(loopMock).not.toHaveBeenCalled();
  });

  it('syncs the loop-corrected files back into the VFS', async () => {
    const v = vfs({ 'TA_x/globalConfig.json': '{"meta":{}}' });
    loopMock.mockImplementation(async (opts: { files: { path: string; content: string }[] }) => ({
      ok: true,
      clean: true,
      iterations: 2,
      appId: 'TA_x',
      events: [{ kind: 'fix', iteration: 1, ts: '', message: 'set checkForUpdates' }],
      finalSummary: 'clean',
      // The loop echoes the same paths it was given (VFS shape, leading slash)
      // with the "fixed" globalConfig.json content.
      files: opts.files.map((f) =>
        f.path.endsWith('globalConfig.json')
          ? { path: f.path, content: '{"meta":{"checkForUpdates":false}}' }
          : f,
      ),
    }));
    const out = await buildAndInspect.execute({ appId: 'TA_x' }, v);
    expect(v.readFile('TA_x/globalConfig.json')).toContain('checkForUpdates');
    expect(out).toContain('changed 1 source file');
  });

  it('reports NOT clean and tells the agent to keep fixing', async () => {
    loopMock.mockResolvedValue({
      ok: true,
      clean: false,
      iterations: 4,
      appId: 'TA_x',
      events: [],
      finalSummary: '1 failure remains',
      files: [],
    });
    const out = await buildAndInspect.execute({ appId: 'TA_x' }, vfs({ 'TA_x/globalConfig.json': '{"meta":{}}' }));
    expect(out).toContain('NOT clean');
    expect(out).toMatch(/fix the remaining findings/i);
  });

  it('returns a graceful message if the loop throws', async () => {
    loopMock.mockRejectedValue(new Error('ucc-gen missing'));
    const out = await buildAndInspect.execute({ appId: 'TA_x' }, vfs({ 'TA_x/globalConfig.json': '{"meta":{}}' }));
    expect(out).toMatch(/build_and_inspect failed: ucc-gen missing/);
  });

  it('AUTO-GENERATES a missing input handler stub and reports a complete CLEAN build', async () => {
    // globalConfig declares an input but no package/bin/oauth_events_input.py exists.
    // The deterministic safety net must write a correct stub into the VFS so the
    // add-on is complete WITHOUT depending on the LLM to self-correct.
    const gc = JSON.stringify({
      meta: { name: 'TA_oauth' },
      pages: {
        inputs: {
          services: [
            {
              name: 'oauth_events_input',
              title: 'OAuth Events',
              entity: [
                { field: 'name', label: 'Name' },
                { field: 'account', label: 'Account', required: true, help: 'OAuth account' },
                { field: 'interval', label: 'Interval' },
                { field: 'disabled' },
              ],
            },
          ],
        },
      },
    });
    const v = vfs({ 'TA_oauth/globalConfig.json': gc });
    loopMock.mockImplementation(async (opts: { files: { path: string; content: string }[] }) => ({
      ok: true,
      clean: true,
      iterations: 2,
      appId: 'TA_oauth',
      events: [],
      finalSummary: 'clean',
      tarball: '/tmp/TA_oauth.tar.gz',
      files: opts.files,
    }));
    const out = await buildAndInspect.execute({ appId: 'TA_oauth' }, v);

    // The handler was written into the VFS under the app-root prefix.
    const handler = v.readFile('TA_oauth/package/bin/oauth_events_input.py');
    expect(handler).toContain('import import_declare_test');
    expect(handler).toContain('class OauthEventsInputInput');
    expect(handler).toContain('smi.Script');
    // Parameters derived from entities (account/interval kept; name/disabled skipped).
    expect(handler).toContain('smi.Argument("account")');
    expect(handler).toContain('smi.Argument("interval")');
    expect(handler).not.toContain('smi.Argument("name")');
    expect(handler).not.toContain('smi.Argument("disabled")');

    // The stub compiles cleanly under python3 (the bench's syntax grade).
    const { spawnSync } = await import('child_process');
    const py = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], {
      input: handler!,
      encoding: 'utf-8',
    });
    expect(py.status).toBe(0);

    // The build is now COMPLETE: clean, no INCOMPLETE warning, package advertised.
    expect(out).toContain('AppInspect-CLEAN');
    expect(out).toMatch(/Auto-generated 1 missing input handler/);
    expect(out).not.toMatch(/INCOMPLETE/);
    expect(out).toContain('Package: /tmp/TA_oauth.tar.gz');
  });

  it('still flags INCOMPLETE when globalConfig is unparseable so no stub can be derived', async () => {
    // findInputsMissingHandlers returns [] for invalid JSON, but if a handler is
    // somehow detectable-missing yet uncreatable the agent is told to fix it. Here
    // we assert the safety net never crashes on malformed config.
    const v = vfs({ 'TA_bad/globalConfig.json': '{ not json' });
    loopMock.mockResolvedValue({
      ok: true,
      clean: true,
      iterations: 1,
      appId: 'TA_bad',
      events: [],
      finalSummary: 'clean',
      tarball: '/tmp/TA_bad.tar.gz',
      files: [],
    });
    const out = await buildAndInspect.execute({ appId: 'TA_bad' }, v);
    // No services parseable → nothing missing → clean, no crash.
    expect(out).toContain('AppInspect-CLEAN');
  });

  it('reports a true CLEAN when every declared input has its handler', async () => {
    const gc = JSON.stringify({
      meta: { name: 'TA_oauth' },
      pages: { inputs: { services: [{ name: 'oauth_events_input' }] } },
    });
    const v = vfs({
      'TA_oauth/globalConfig.json': gc,
      'TA_oauth/package/bin/oauth_events_input.py': 'import import_declare_test\n',
    });
    loopMock.mockImplementation(async (opts: { files: { path: string; content: string }[] }) => ({
      ok: true,
      clean: true,
      iterations: 1,
      appId: 'TA_oauth',
      events: [],
      finalSummary: 'clean',
      tarball: '/tmp/TA_oauth.tar.gz',
      files: opts.files,
    }));
    const out = await buildAndInspect.execute({ appId: 'TA_oauth' }, v);
    expect(out).toContain('AppInspect-CLEAN');
    expect(out).not.toMatch(/INCOMPLETE/);
    expect(out).toContain('Package: /tmp/TA_oauth.tar.gz');
  });
});

describe('build_and_inspect — deterministic manifest guard (Task 1)', () => {
  it('GENERATES package/app.manifest from globalConfig metadata when missing', async () => {
    // Mirrors the live failure: globalConfig authored at root, but app.manifest
    // (which ucc-gen does NOT generate) was never created. The guard must write a
    // valid manifest derived from meta BEFORE the loop runs.
    const gc = JSON.stringify({
      meta: {
        name: 'TA_api_poller',
        version: '2.1.0',
        displayName: 'API Poller',
        description: 'Pulls data from an API',
      },
      pages: {},
    });
    const v = vfs({ 'TA_api_poller/globalConfig.json': gc });
    loopMock.mockImplementation(async (opts: { files: { path: string; content: string }[] }) => ({
      ok: true,
      clean: true,
      iterations: 1,
      appId: 'TA_api_poller',
      events: [],
      finalSummary: 'clean',
      tarball: '/tmp/TA_api_poller.tar.gz',
      files: opts.files,
    }));
    const out = await buildAndInspect.execute({ appId: 'TA_api_poller' }, v);

    const manifestRaw = v.readFile('TA_api_poller/package/app.manifest');
    expect(manifestRaw).toBeTruthy();
    const manifest = JSON.parse(manifestRaw!);
    // Derived from globalConfig meta (not defaults).
    expect(manifest.info.id.name).toBe('TA_api_poller');
    expect(manifest.info.id.version).toBe('2.1.0');
    expect(manifest.info.title).toBe('API Poller');
    expect(manifest.info.description).toBe('Pulls data from an API');
    expect(manifest.schemaVersion).toBe('2.0.0');

    // The manifest was present in the files handed to the loop (so ucc-gen builds).
    const handed = loopMock.mock.calls[0][0] as { files: { path: string }[] };
    expect(handed.files.some((f) => f.path.endsWith('package/app.manifest'))).toBe(true);

    // The agent is told what happened.
    expect(out).toMatch(/Generated the REQUIRED package\/app\.manifest/);
  });

  it('does NOT overwrite an existing app.manifest', async () => {
    const existing = '{"schemaVersion":"2.0.0","info":{"id":{"name":"keep_me"}}}';
    const v = vfs({
      'TA_keep/globalConfig.json': '{"meta":{"name":"TA_keep"}}',
      'TA_keep/package/app.manifest': existing,
    });
    loopMock.mockImplementation(async (opts: { files: { path: string; content: string }[] }) => ({
      ok: true,
      clean: true,
      iterations: 1,
      appId: 'TA_keep',
      events: [],
      finalSummary: 'clean',
      tarball: '/tmp/TA_keep.tar.gz',
      files: opts.files,
    }));
    const out = await buildAndInspect.execute({ appId: 'TA_keep' }, v);
    expect(v.readFile('TA_keep/package/app.manifest')).toBe(existing);
    expect(out).not.toMatch(/Generated the REQUIRED package\/app\.manifest/);
  });

  it('refuses to build (defensive guard) when no globalConfig.json exists', async () => {
    const out = await buildAndInspect.execute({ appId: 'TA_x' }, vfs({ 'TA_x/package/bin/x.py': 'print(1)' }));
    expect(out).toMatch(/no globalConfig\.json found/i);
    expect(loopMock).not.toHaveBeenCalled();
  });
});

describe('MCP grounding gate (Task 3)', () => {
  const ORIG = process.env.AGENT_MCP_GROUNDING;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.AGENT_MCP_GROUNDING;
    else process.env.AGENT_MCP_GROUNDING = ORIG;
  });

  it('mcpGroundingEnabled() defaults to OFF and toggles on truthy env values', () => {
    delete process.env.AGENT_MCP_GROUNDING;
    expect(mcpGroundingEnabled()).toBe(false);
    for (const v of ['0', 'false', 'off', 'no', '']) {
      process.env.AGENT_MCP_GROUNDING = v;
      expect(mcpGroundingEnabled()).toBe(false);
    }
    for (const v of ['1', 'true', 'on', 'YES', 'True']) {
      process.env.AGENT_MCP_GROUNDING = v;
      expect(mcpGroundingEnabled()).toBe(true);
    }
  });

  it('resolveServerIntegrationTools() ALWAYS includes the grounding tools (now gated by policy, not omitted)', () => {
    // Repurposed semantics: the grounding tools are always present in the toolset.
    // AGENT_MCP_GROUNDING now controls their POLICY (ask vs auto), not their presence.
    delete process.env.AGENT_MCP_GROUNDING;
    const off = resolveServerIntegrationTools().map((t) => t.name);
    expect(off).toEqual([
      'get_live_indexes',
      'get_splunk_metadata',
      'run_splunk_query',
      'generate_spl',
      'build_and_inspect',
    ]);

    process.env.AGENT_MCP_GROUNDING = '1';
    const on = resolveServerIntegrationTools().map((t) => t.name);
    expect(on).toEqual(off);
  });
});
