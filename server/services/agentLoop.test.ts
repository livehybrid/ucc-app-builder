import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppInspectCheck, AppInspectReport } from './appInspect.js';

/**
 * runAgentLoop wires together ucc-gen (build/package), AppInspect, and a fixer.
 * For the no-progress / env-default tests we mock those collaborators so the loop
 * is fully deterministic — no Docker, no LLM, no filesystem.
 *
 * The mock controls what AppInspect returns per iteration via a queue, so we can
 * simulate "the fix changed nothing → identical findings".
 */

// --- mock state, controllable per-test ----------------------------------------
const inspectQueue: AppInspectReport[] = [];
const buildSpy = vi.fn();
// Per-iteration build behaviour: push an Error to make ucc-gen build throw with a
// given log line, or null/undefined to let it succeed. Drains one per build; once
// empty, builds succeed. Lets us simulate ucc-gen build failures deterministically.
const buildBehavior: Array<Error | null> = [];

function reportWith(checks: AppInspectCheck[]): AppInspectReport {
  return {
    summary: { failure: checks.filter((c) => c.result === 'failure').length },
    checks,
    raw: '',
    source: 'cli',
  };
}

vi.mock('./uccGen.js', () => ({
  UCCGenService: class {
    async init() {
      /* no-op */
    }
    async build(_workDir: string, onLog?: (l: string) => void) {
      buildSpy();
      const next = buildBehavior.length ? buildBehavior.shift() : null;
      if (next instanceof Error) {
        onLog?.(next.message);
        throw next;
      }
      return '/tmp/out';
    }
    async package() {
      return '/tmp/out/app.tar.gz';
    }
  },
}));

vi.mock('./appInspect.js', () => ({
  AppInspectService: class {
    async inspectTarball(): Promise<AppInspectReport> {
      // Return the next queued report, or repeat the last one forever.
      return inspectQueue.length > 1 ? inspectQueue.shift()! : inspectQueue[0];
    }
    summarise() {
      return 'summary';
    }
    actionableChecks(report: AppInspectReport): AppInspectCheck[] {
      return report.checks.filter((c) => c.result === 'failure' || c.result === 'warning');
    }
  },
}));

vi.mock('../utils/fileHandler.js', () => ({
  FileHandler: class {
    async createTempDirectory() {
      return '/tmp/work';
    }
    async writeFiles() {
      /* no-op */
    }
  },
}));

vi.mock('./traceLogger.js', () => ({
  traceLogger: { log: vi.fn().mockResolvedValue(undefined) },
}));

// Import AFTER mocks are registered.
import { runAgentLoop, resolveInspectMaxIterations } from './agentLoop.js';

// Use a check the deterministic fixer DOES act on, so a fix runs (changedThisRound
// > 0) — but our mocked AppInspect keeps returning the same finding, simulating a
// fix that "changed nothing". This isolates the identical-findings breaker from the
// pre-existing "no fixer changed anything" guard.
const failingCheck: AppInspectCheck = {
  check: 'check_for_updates_disabled',
  result: 'failure',
  message: 'check_for_updates not disabled',
  description: 'updates should be disabled',
  messages: [{ message: 'enable disabled', message_filename: 'default/app.conf', message_line: 1 }],
};

const baseOpts = {
  sessionId: 's1',
  appId: 'TA_test',
  files: [{ path: 'TA_test/globalConfig.json', content: '{"meta":{}}' }],
  useLlm: false, // no LLM in tests
};

beforeEach(() => {
  inspectQueue.length = 0;
  buildBehavior.length = 0;
  buildSpy.mockReset();
});

afterEach(() => {
  delete process.env.AGENT_INSPECT_MAX_ITERATIONS;
});

describe('runAgentLoop no-progress breaker', () => {
  it('breaks early when findings are identical to the previous iteration (fix changed nothing)', async () => {
    // Same failing report every iteration → no fixer can change it. With no LLM
    // and no deterministic rule for this check, the loop would otherwise grind to
    // maxIterations. The identical-findings breaker must stop it after iteration 2.
    inspectQueue.push(reportWith([failingCheck]));

    const res = await runAgentLoop({
      ...baseOpts,
      maxIterations: 8,
      onEvent: undefined,
    });

    expect(res.clean).toBe(false);
    // Iteration 1 records findings; iteration 2 sees identical findings → break.
    expect(res.iterations).toBe(2);
    const exhausted = res.events.find(
      (e) => e.kind === 'exhausted' && /did not change|no progress/i.test(e.message)
    );
    expect(exhausted).toBeTruthy();
  });

  it('stops normally (clean) when AppInspect reports no actionable checks', async () => {
    inspectQueue.push(reportWith([])); // clean on first inspect
    const res = await runAgentLoop({ ...baseOpts, maxIterations: 8 });
    expect(res.clean).toBe(true);
    expect(res.iterations).toBe(1);
  });
});

describe('deterministic build-error fixer: missing app.manifest (Task 1)', () => {
  it('generates package/app.manifest from globalConfig metadata, then builds clean', async () => {
    // Iteration 1: ucc-gen fails because app.manifest is absent. The rule fixer
    // writes it from globalConfig meta. Iteration 2: build succeeds, AppInspect clean.
    buildBehavior.push(
      new Error('ucc-gen package failed with code 1: package/app.manifest not found')
    );
    inspectQueue.push(reportWith([])); // clean once the build succeeds

    const res = await runAgentLoop({
      ...baseOpts,
      files: [
        {
          path: 'TA_test/globalConfig.json',
          content: JSON.stringify({
            meta: { name: 'TA_test', version: '3.0.0', displayName: 'Test' },
          }),
        },
      ],
      maxIterations: 6,
    });

    expect(res.clean).toBe(true);
    const manifest = res.files.find((f) => f.path.endsWith('package/app.manifest'));
    expect(manifest).toBeTruthy();
    const parsed = JSON.parse(manifest!.content);
    expect(parsed.info.id.name).toBe('TA_test');
    expect(parsed.info.id.version).toBe('3.0.0');
    expect(parsed.info.title).toBe('Test');
    // A build-error fix event names the rule.
    const fix = res.events.find((e) => e.kind === 'fix' && /app\.manifest/i.test(e.message));
    expect(fix).toBeTruthy();
  });
});

describe('deterministic build-error fixer: invalid table actions (ucc-gen 6.5+ strict enum)', () => {
  it("strips 'enable' from table actions, then builds clean", async () => {
    // Configs authored under ucc-gen <=6.4 commonly carry 'enable'; 6.5 hard-fails.
    buildBehavior.push(
      new Error(
        "globalConfig file is not valid. Error: 'enable' is not one of ['edit', 'delete', 'clone', 'search']"
      )
    );
    inspectQueue.push(reportWith([])); // clean once the build succeeds

    const res = await runAgentLoop({
      ...baseOpts,
      files: [
        { path: 'TA_test/package/app.manifest', content: '{"schemaVersion":"2.0.0"}' },
        {
          path: 'TA_test/globalConfig.json',
          content: JSON.stringify({
            meta: { name: 'TA_test', version: '1.0.0', displayName: 'Test' },
            pages: {
              inputs: {
                title: 'Inputs',
                services: [{ name: 'demo', title: 'Demo', entity: [] }],
                table: {
                  header: [{ label: 'Name', field: 'name' }],
                  actions: ['edit', 'enable', 'delete', 'clone'],
                },
              },
            },
          }),
        },
      ],
      maxIterations: 6,
    });

    expect(res.clean).toBe(true);
    const gc = res.files.find((f) => f.path.endsWith('globalConfig.json'));
    const parsed = JSON.parse(gc!.content);
    expect(parsed.pages.inputs.table.actions).toEqual(['edit', 'delete', 'clone']);
    const fix = res.events.find((e) => e.kind === 'fix' && /invalid table action/i.test(e.message));
    expect(fix).toBeTruthy();
  });
});

describe('deterministic build-error fixer: INVALID existing app.manifest', () => {
  it('replaces a manifest that fails ucc-gen validation with one generated from globalConfig', async () => {
    // LLM-authored manifests ship wrong enums/extra fields; ucc-gen's
    // AppManifest.validate() rejects them. The rule fixer must replace the file
    // wholesale instead of looping on LLM rewrites.
    buildBehavior.push(
      new Error(
        'Manifest file @ /tmp/work/package/app.manifest has invalid format.\n' +
          'Error message: supportedDeployments should be set.'
      )
    );
    inspectQueue.push(reportWith([])); // clean once the build succeeds

    const res = await runAgentLoop({
      ...baseOpts,
      files: [
        {
          path: 'TA_test/globalConfig.json',
          content: JSON.stringify({
            meta: { name: 'TA_test', version: '2.0.0', displayName: 'Test' },
          }),
        },
        {
          // Invalid: missing supportedDeployments/targetWorkloads, has bogus fields.
          path: 'TA_test/package/app.manifest',
          content: JSON.stringify({
            schemaVersion: '2.0.0',
            info: { id: { name: 'TA_test', version: '2.0.0' } },
            visibility: true,
            snapshotCompatibility: '8.0',
          }),
        },
      ],
      maxIterations: 6,
    });

    expect(res.clean).toBe(true);
    const manifest = res.files.find((f) => f.path.endsWith('package/app.manifest'));
    const parsed = JSON.parse(manifest!.content);
    expect(parsed.supportedDeployments).toEqual([
      '_standalone',
      '_distributed',
      '_search_head_clustering',
    ]);
    expect(parsed.targetWorkloads).toEqual(['_search_heads']);
    expect(parsed.visibility).toBeUndefined();
    expect(parsed.info.id.version).toBe('2.0.0');
    const fix = res.events.find(
      (e) => e.kind === 'fix' && /replaced invalid package\/app\.manifest/i.test(e.message)
    );
    expect(fix).toBeTruthy();
  });
});

describe('build-error stuck-loop breaker: identical error 3 iterations running', () => {
  it('stops even when LLM fixes DO change files but the identical error persists', async () => {
    // The live trace: the LLM rewrote app.manifest with the "same fix" on it2/it3/it4
    // while the build failed identically each time. changed:[] never triggered, so the
    // loop ground on. The streak breaker must stop at the 3rd identical error.
    const err = 'ucc-gen package failed with code 1: some unfixable thing';
    buildBehavior.push(new Error(err), new Error(err), new Error(err), new Error(err));

    let call = 0;
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              // A REAL file change each call (content differs per call), so the
              // changed:[] breaker never fires.
              content: JSON.stringify({
                files: [{ path: 'TA_test/package/bin/poller.py', content: `# try ${++call}\n` }],
                note: 'Fixed app.manifest JSON formatting',
              }),
            },
          },
        ],
      }),
    }));
    const prevFetch = globalThis.fetch;
    const prevKey = process.env.OPENROUTER_API_KEY;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.OPENROUTER_API_KEY = 'test-key';

    try {
      const res = await runAgentLoop({
        ...baseOpts,
        files: [
          { path: 'TA_test/globalConfig.json', content: '{"meta":{"name":"TA_test"}}' },
          { path: 'TA_test/package/app.manifest', content: '{"schemaVersion":"2.0.0"}' },
          { path: 'TA_test/package/bin/poller.py', content: '# v0\n' },
        ],
        maxIterations: 8,
        useLlm: true,
      });

      expect(res.clean).toBe(false);
      expect(res.iterations).toBe(3);
      const exhausted = res.events.find(
        (e) => e.kind === 'exhausted' && /identical build error occurred 3 iterations/i.test(e.message)
      );
      expect(exhausted).toBeTruthy();
    } finally {
      globalThis.fetch = prevFetch;
      if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevKey;
    }
  });
});

describe('build-error no-progress breaker: no-op LLM fix + identical error (Task 4)', () => {
  it('breaks early when the LLM build-error fix reports changed:[] and the same error repeats', async () => {
    // The manifest already exists (so the deterministic manifest rule never fires)
    // and no other rule matches this error → the loop falls to the LLM fixer. We mock
    // the LLM to return {files:[]} (a no-op "I fixed it" claim — exactly the live
    // trace). The build keeps failing with the IDENTICAL error. The explicit breaker
    // must stop after iteration 2 (changed:[] AND same error) rather than to the cap.
    const err = 'ucc-gen package failed with code 1: some unfixable thing';
    buildBehavior.push(
      new Error(err),
      new Error(err),
      new Error(err),
      new Error(err),
      new Error(err)
    );

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"files":[],"note":"Created missing manifest"}' } }],
      }),
    });
    const prevFetch = globalThis.fetch;
    const prevKey = process.env.OPENROUTER_API_KEY;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.OPENROUTER_API_KEY = 'test-key';

    try {
      const res = await runAgentLoop({
        ...baseOpts,
        files: [
          { path: 'TA_test/globalConfig.json', content: '{"meta":{"name":"TA_test"}}' },
          { path: 'TA_test/package/app.manifest', content: '{"schemaVersion":"2.0.0"}' },
        ],
        maxIterations: 8,
        useLlm: true,
      });

      expect(res.clean).toBe(false);
      // Iter 1: build fails, LLM no-op fix. Iter 2: identical error + changed:[] → break.
      expect(res.iterations).toBe(2);
      const exhausted = res.events.find(
        (e) => e.kind === 'exhausted' && /no progress.*changed: \[\]/i.test(e.message)
      );
      expect(exhausted).toBeTruthy();
    } finally {
      globalThis.fetch = prevFetch;
      if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevKey;
    }
  });
});

describe('resolveInspectMaxIterations (env-var default)', () => {
  it('prefers explicit, then AGENT_INSPECT_MAX_ITERATIONS, then 4', () => {
    delete process.env.AGENT_INSPECT_MAX_ITERATIONS;
    expect(resolveInspectMaxIterations()).toBe(4);
    expect(resolveInspectMaxIterations(6)).toBe(6);
    process.env.AGENT_INSPECT_MAX_ITERATIONS = '9';
    expect(resolveInspectMaxIterations()).toBe(9);
    expect(resolveInspectMaxIterations(2)).toBe(2); // explicit wins
  });
});
