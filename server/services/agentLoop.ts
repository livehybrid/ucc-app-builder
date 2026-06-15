import path from 'path';
import { UCCGenService } from './uccGen.js';
import { AppInspectService, AppInspectCheck, AppInspectReport } from './appInspect.js';
import { FileHandler } from '../utils/fileHandler.js';
import { traceLogger } from './traceLogger.js';
import { appManifestFromGlobalConfig } from '../../src/lib/generator.js';

/**
 * The keystone agentic loop.
 *
 *   generate (ucc-gen build + package) -> appinspect -> parse actionable checks
 *   -> auto-fix (deterministic rules first, then LLM) -> re-run until clean
 *   or maxIterations reached.
 *
 * Every step emits a trace event (also persisted as JSONL via traceLogger) so the
 * UI / CLI can render the "draft -> validate -> fix -> revise" loop — the demo
 * money-shot for the hackathon.
 *
 * The fix step edits the *source* files under `package/` (the same VFS files the
 * builder ships), NOT the generated output, so fixes are reproducible: the next
 * iteration rebuilds from the corrected source.
 */

export interface LoopFile {
  path: string;
  content: string;
}

export type LoopEventKind =
  | 'start'
  | 'build'
  | 'build_error'
  | 'package'
  | 'inspect'
  | 'fix'
  | 'fix_skipped'
  | 'iteration'
  | 'clean'
  | 'exhausted'
  | 'done';

export interface LoopEvent {
  kind: LoopEventKind;
  iteration: number;
  ts: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface LoopOptions {
  sessionId: string;
  appId: string;
  files: LoopFile[];
  version?: string;
  maxIterations?: number;
  /** Treat warnings as actionable (loop tries to clear them too). Default true. */
  includeWarnings?: boolean;
  /** Allow the LLM fixer when deterministic rules can't resolve a check. Default true if key present. */
  useLlm?: boolean;
  /** Skip deterministic rule fixers and route everything to the LLM (demo / eval). Default false. */
  llmOnly?: boolean;
  onEvent?: (e: LoopEvent) => void;
}

export interface LoopResult {
  ok: boolean;
  clean: boolean;
  iterations: number;
  appId: string;
  tarball?: string;
  finalSummary?: string;
  finalReport?: AppInspectReport;
  files: LoopFile[];
  events: LoopEvent[];
}

const ucc = new UCCGenService();
const appInspect = new AppInspectService();
const fileHandler = new FileHandler();

function openRouterApiKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_APIKEY;
}

/** Default iteration cap for the AppInspect self-correct loop (env override). */
export const FALLBACK_INSPECT_MAX_ITERATIONS = 4;

/** Resolve the AppInspect-loop iteration cap from an explicit value, then AGENT_INSPECT_MAX_ITERATIONS, then 4. */
export function resolveInspectMaxIterations(explicit?: number): number {
  const fromEnv = Number(process.env.AGENT_INSPECT_MAX_ITERATIONS);
  const raw = Number.isFinite(Number(explicit))
    ? Number(explicit)
    : Number.isFinite(fromEnv)
      ? fromEnv
      : FALLBACK_INSPECT_MAX_ITERATIONS;
  return Math.max(1, Math.floor(raw));
}

/** The model the fixer uses. Defaults to Claude via OpenRouter per the brief. */
function fixerModel(): string {
  return process.env.UCC_FIXER_MODEL || process.env.MODEL_EXECUTOR || 'anthropic/claude-sonnet-4.5';
}

/**
 * Map a loop "source" path back to the on-disk workDir path used by ucc-gen.
 * The builder VFS uses `<appId>/package/...` and `<appId>/globalConfig.json`;
 * on disk ucc-gen wants `package/...` and a root `globalConfig.json`.
 */
function toWorkPath(loopPath: string, appId: string): string | null {
  let p = loopPath.replace(/^\/+/, '');
  if (p.startsWith(`${appId}/`)) p = p.slice(appId.length + 1);
  if (p === 'globalConfig.json') return 'globalConfig.json';
  if (p.startsWith('package/')) return p;
  return null;
}

/**
 * Deterministic fixers for well-known AppInspect checks. These run before any
 * LLM call: they are free, instant, and reliable. Returns the set of files that
 * were changed (by their loop path).
 */
function deterministicFix(
  check: AppInspectCheck,
  files: Map<string, string>,
  appId: string
): { changed: string[]; note: string } | null {
  const findFile = (suffix: string): string | undefined =>
    [...files.keys()].find((k) => k.endsWith(suffix));

  switch (check.check) {
    case 'check_for_updates_disabled': {
      // UCC REGENERATES default/app.conf from globalConfig on every build, so
      // editing app.conf is futile — the knob lives at meta.checkForUpdates.
      // (Confirmed in ucc 6.4.0 create_app_conf.py: meta.checkForUpdates === false
      //  -> check_for_updates = false.)
      const gcKey = findFile('globalConfig.json');
      if (!gcKey) return null;
      try {
        const gc = JSON.parse(files.get(gcKey)!);
        if (gc?.meta?.checkForUpdates === false) return null; // already set
        gc.meta = gc.meta ?? {};
        gc.meta.checkForUpdates = false;
        files.set(gcKey, JSON.stringify(gc, null, 2));
        return { changed: [gcKey], note: 'Set meta.checkForUpdates=false in globalConfig.json.' };
      } catch {
        return null;
      }
    }

    case 'check_for_local_meta': {
      // AppInspect forbids shipping metadata/local.meta — settings must live in
      // default.meta. Drop the file from the source so the next build omits it.
      const key = findFile('metadata/local.meta');
      if (!key) return null;
      files.delete(key);
      return {
        changed: [key],
        note: 'Removed metadata/local.meta (forbidden by AppInspect; use default.meta).',
      };
    }

    case 'check_aarch64_compatibility': {
      // solnlib 8.x bundles AArch64-incompatible native deps (protobuf `_upb`,
      // grpc cython .so). The fix is to pin solnlib <8 in requirements.txt so the
      // next build installs the pure-Python 7.x line. (See README dependency pins.)
      const reqKey = findFile('package/lib/requirements.txt');
      if (!reqKey) return null;
      const existing = files.get(reqKey) ?? '';
      // Already correctly bounded? Nothing to do (the .so must come from elsewhere).
      if (/solnlib\s*[><=].*<\s*8/.test(existing)) return null;
      let next: string;
      if (/^\s*solnlib\b/m.test(existing)) {
        next = existing.replace(/^\s*solnlib\b.*$/m, 'solnlib>=5.0.0,<8');
      } else {
        next = `solnlib>=5.0.0,<8\n${existing}`;
      }
      // Also bound splunktaucclib if present-but-unbounded (it pulls solnlib).
      if (/^\s*splunktaucclib\b/m.test(next) && !/splunktaucclib[^\n]*<\s*9/.test(next)) {
        next = next.replace(/^\s*splunktaucclib\b.*$/m, 'splunktaucclib>=6.6.0,<9');
      }
      files.set(reqKey, next);
      return {
        changed: [reqKey],
        note: 'Pinned solnlib>=5.0.0,<8 (AArch64-safe) in requirements.txt to drop incompatible protobuf/grpc binaries.',
      };
    }

    case 'check_static_directory_file_allow_list': {
      // Only .png/.txt files are allowed under static/. The legacy generator wrote a
      // bare `static/README` placeholder; remove any non-png/txt file in static/.
      const offending = [...files.keys()].filter(
        (k) => /(^|\/)static\//.test(k) && !/\.(png|txt)$/i.test(k)
      );
      if (offending.length === 0) return null;
      offending.forEach((k) => files.delete(k));
      return {
        changed: offending,
        note: `Removed non-image file(s) from static/: ${offending.map((k) => k.split('/').pop()).join(', ')}.`,
      };
    }

    default:
      return null;
  }
}

/**
 * Deterministic fixes for known ucc-gen BUILD failures (not appinspect checks).
 * Matches on the build log text. Returns changed files or null.
 */
function deterministicBuildFix(
  buildLog: string,
  files: Map<string, string>,
  appId: string
): { changed: string[]; note: string } | null {
  const findFile = (suffix: string): string | undefined =>
    [...files.keys()].find((k) => k.endsWith(suffix));

  // ucc-gen REQUIRES package/app.manifest but does NOT generate it. If it is
  // missing the build fails (commonly "app.manifest ... not found" / "package
  // failed"). Synthesise a valid manifest from globalConfig.json metadata rather
  // than routing this to the flaky LLM path (which has shipped `changed: []`).
  const hasManifest = [...files.keys()].some((k) =>
    k.replace(/^\/+/, '').endsWith('package/app.manifest')
  );
  if (
    !hasManifest &&
    /app\.manifest|manifest.*not found|no such file.*manifest|package failed/i.test(buildLog)
  ) {
    const gcKey = findFile('globalConfig.json');
    let gc: { meta?: Record<string, unknown> } | null = null;
    if (gcKey) {
      try {
        gc = JSON.parse(files.get(gcKey)!);
      } catch {
        gc = null;
      }
    }
    const manifest = appManifestFromGlobalConfig(gc, appId);
    // Place the manifest under the same app-root prefix the other package/ files
    // use, so it maps onto disk correctly (toWorkPath strips the appId prefix).
    const anyPkg = [...files.keys()].find((k) => k.replace(/^\/+/, '').includes('/package/'));
    const prefix = anyPkg ? anyPkg.replace(/^\/+/, '').split('package/')[0] : `${appId}/`;
    const manifestKey = `${prefix}package/app.manifest`;
    files.set(manifestKey, JSON.stringify(manifest, null, 2));
    return {
      changed: [manifestKey],
      note: 'Generated required package/app.manifest from globalConfig.json metadata (ucc-gen does not create it).',
    };
  }

  // app.manifest EXISTS but is INVALID. LLM-authored manifests routinely ship
  // trailing commas (JSON parse failure) or wrong schemaVersion/supportedDeployments/
  // targetWorkloads values, and the LLM fix path has looped repeating the same
  // ineffective "fix" on these. ucc-gen's AppManifest.validate() error strings are
  // stable (app_manifest.py) — on any of them, replace the manifest wholesale with
  // the known-good one generated from globalConfig metadata.
  const existingManifestKey = [...files.keys()].find((k) =>
    k.replace(/^\/+/, '').endsWith('package/app.manifest')
  );
  if (
    existingManifestKey &&
    /could not parse app\.manifest|manifest file .* has invalid format|supportedDeployments should|targetWorkloads should|schemaVersion should be/i.test(
      buildLog
    )
  ) {
    const gcKey = findFile('globalConfig.json');
    let gc: { meta?: Record<string, unknown> } | null = null;
    if (gcKey) {
      try {
        gc = JSON.parse(files.get(gcKey)!);
      } catch {
        gc = null;
      }
    }
    const fresh = JSON.stringify(appManifestFromGlobalConfig(gc, appId), null, 2);
    if (files.get(existingManifestKey) !== fresh) {
      files.set(existingManifestKey, fresh);
      return {
        changed: [existingManifestKey],
        note: 'Replaced invalid package/app.manifest with a known-good manifest generated from globalConfig.json metadata (schemaVersion 2.0.0, valid supportedDeployments/targetWorkloads).',
      };
    }
    // Already the known-good manifest yet still failing — not a manifest problem
    // we can fix deterministically; fall through.
  }

  // UCC schema requires every inputs page to declare a `table` (the columns shown
  // in the inputs list). Agents frequently add an inputs page + services but omit
  // the table, producing: `globalConfig file is not valid. Error: 'table' is a
  // required property`. Synthesise a minimal valid table from the first service's
  // declared entities. Deterministic + reliable; the LLM tends to mis-place it.
  if (/'table' is a required property|table.*is a required property/i.test(buildLog)) {
    const gcKey = findFile('globalConfig.json');
    if (gcKey) {
      try {
        const gc = JSON.parse(files.get(gcKey)!);
        const inputs = gc?.pages?.inputs;
        const services = inputs?.services;
        if (inputs && Array.isArray(services) && services.length > 0 && !inputs.table) {
          const first = services[0];
          const entities: Array<{ field?: string; label?: string }> = Array.isArray(first?.entity)
            ? first.entity
            : [];
          const header = [
            { label: 'Name', field: 'name' },
            ...entities
              .filter((e) => e.field && e.field !== 'name')
              .slice(0, 4)
              .map((e) => ({ label: e.label || e.field!, field: e.field! })),
            { label: 'Status', field: 'disabled' },
          ];
          inputs.table = {
            header,
            // Schema enum is edit/delete/clone/search only — 'enable' is invalid
            // (enable/disable comes from the `disabled` column) and ucc-gen 6.5+
            // hard-fails on it.
            actions: ['edit', 'delete', 'clone'],
          };
          files.set(gcKey, JSON.stringify(gc, null, 2));
          return {
            changed: [gcKey],
            note: "Added required pages.inputs.table (UCC schema) from the first service's entities.",
          };
        }
      } catch {
        // fall through to other fixers
      }
    }
  }

  // Invalid table action values. The schema enums are strict — inputs tables
  // allow only edit/delete/clone/search, configuration tables edit/delete/clone
  // — but configs authored under ucc-gen <=6.4 (which didn't enforce this) often
  // carry 'enable'. ucc-gen 6.5+ hard-fails: `Error: 'enable' is not one of
  // ['edit', 'delete', 'clone', 'search']`. Strip unknown actions.
  if (/is not one of \[[^\]]*'edit'[^\]]*\]/i.test(buildLog)) {
    const gcKey = findFile('globalConfig.json');
    if (gcKey) {
      try {
        const gc = JSON.parse(files.get(gcKey)!);
        const allowed = new Set(['edit', 'delete', 'clone', 'search']);
        let removed: string[] = [];
        const sanitize = (table: { actions?: unknown } | undefined) => {
          if (!table || !Array.isArray(table.actions)) return;
          const bad = (table.actions as string[]).filter((a) => !allowed.has(a));
          if (bad.length) {
            removed = removed.concat(bad);
            table.actions = (table.actions as string[]).filter((a) => allowed.has(a));
          }
        };
        sanitize(gc?.pages?.inputs?.table);
        for (const svc of gc?.pages?.inputs?.services ?? []) sanitize(svc?.table);
        for (const tab of gc?.pages?.configuration?.tabs ?? []) sanitize(tab?.table);
        if (removed.length) {
          files.set(gcKey, JSON.stringify(gc, null, 2));
          return {
            changed: [gcKey],
            note: `Removed invalid table action(s) ${[...new Set(removed)].join(', ')} from globalConfig.json (schema allows edit/delete/clone/search only).`,
          };
        }
      } catch {
        // fall through to other fixers
      }
    }
  }

  // UI add-ons must declare splunktaucclib in package/lib/requirements.txt.
  if (/splunktaucclib is required but not found|splunktaucclib.*required/i.test(buildLog)) {
    const reqKey =
      findFile('package/lib/requirements.txt') || `${appId}/package/lib/requirements.txt`;
    const existing = files.get(reqKey) ?? '';
    if (/splunktaucclib/.test(existing)) return null; // already there; not this fix
    // Pin solnlib <8: solnlib 8.x bundles AArch64-incompatible native deps
    // (protobuf/grpc .so files) that fail AppInspect check_aarch64_compatibility.
    // splunktaucclib pins solnlib>=5 unbounded, so the upper bound MUST be explicit.
    const next = `splunktaucclib>=6.6.0,<9\nsolnlib>=5.0.0,<8\n${existing}`;
    files.set(reqKey, next);
    return {
      changed: [reqKey],
      note: 'Added splunktaucclib>=6.6.0,<9 and solnlib>=5.0.0,<8 (AArch64-safe pins) to package/lib/requirements.txt.',
    };
  }

  return null;
}

/**
 * LLM fixer (OpenRouter -> Claude). Given the actionable checks and the current
 * source files, asks for full-file replacements. Returns the changed files.
 */
async function llmFix(
  checks: AppInspectCheck[],
  files: Map<string, string>,
  appId: string
): Promise<{ changed: string[]; note: string }> {
  const apiKey = openRouterApiKey();
  if (!apiKey) return { changed: [], note: 'No OPENROUTER_API_KEY — skipped LLM fix.' };

  // Only send text files that the checks reference (plus globalConfig + app.conf),
  // to keep the prompt small and within Anthropic tool limits.
  const referenced = new Set<string>();
  for (const c of checks) {
    for (const m of c.messages ?? []) {
      const f = m.message_filename;
      if (!f) continue;
      const key = [...files.keys()].find((k) => k.endsWith(f.replace(/^package\//, 'package/')));
      if (key) referenced.add(key);
    }
  }
  // Always include the manifest + app.conf + globalConfig as fixable context.
  for (const suffix of ['package/app.manifest', 'package/default/app.conf', 'globalConfig.json']) {
    const key = [...files.keys()].find((k) => k.endsWith(suffix));
    if (key) referenced.add(key);
  }

  const fileBlocks = [...referenced]
    .filter((k) => !/\.(png|jpg|jpeg|gif|ico)$/.test(k))
    .map((k) => `### FILE: ${k}\n\`\`\`\n${files.get(k)}\n\`\`\``)
    .join('\n\n');

  const checkBlocks = checks
    .map((c) => {
      const msgs = (c.messages ?? [])
        .map(
          (m) =>
            `  - ${m.message}${m.message_filename ? ` (${m.message_filename}:${m.message_line ?? '?'})` : ''}`
        )
        .join('\n');
      return `* [${c.result}] ${c.check}: ${c.description ?? ''}\n${msgs}`;
    })
    .join('\n');

  const system =
    'You are a Splunk add-on packaging expert fixing splunk-appinspect findings on a ' +
    'UCC (Universal Configuration Console) add-on. ' +
    'Return ONLY a JSON object: {"files":[{"path":"<exact path as given>","content":"<full new file content>"}],"note":"<one line>"}. ' +
    'Only include files you actually change. Make the minimal edits needed to clear the checks. ' +
    'Do not invent files. Preserve everything not related to the findings.\n\n' +
    'CRITICAL UCC BUILD BEHAVIOUR — fixes to generated files will NOT stick:\n' +
    '- `ucc-gen build` REGENERATES `default/app.conf` from `globalConfig.json` on every build. ' +
    'NEVER edit default/app.conf directly — change the source in globalConfig.json instead.\n' +
    '- To set check_for_updates=false (check_for_updates_disabled), set "meta": {"checkForUpdates": false} ' +
    'in globalConfig.json. UCC reads meta.checkForUpdates and renders app.conf accordingly.\n' +
    '- To set the add-on version, change meta.version in globalConfig.json (and info.id.version in app.manifest).\n' +
    '- `inputs.conf`, `*.conf.spec`, `README/` and `appserver/static/js/build/` are UCC-generated; ' +
    'do not hand-edit them. Fix the cause in globalConfig.json or package/bin source.\n' +
    'For .conf files you legitimately own (custom conf), keep valid Splunk stanza syntax.';

  const user = `AppInspect findings to fix:\n${checkBlocks}\n\nCurrent source files:\n\n${fileBlocks}`;

  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://splunk.engineer',
      'X-Title': 'UCCBuilder-AppInspectLoop',
    },
    body: JSON.stringify({
      model: fixerModel(),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: 4096,
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`LLM fixer error (${resp.status}): ${text.slice(0, 300)}`);
  }
  const json = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content ?? '{}';
  let parsed: { files?: Array<{ path: string; content: string }>; note?: string };
  try {
    parsed = JSON.parse(content);
  } catch {
    // Some models wrap JSON in prose / code fences; extract the first {...} block.
    const match = content.match(/\{[\s\S]*\}/);
    parsed = match ? JSON.parse(match[0]) : { files: [] };
  }

  const changed: string[] = [];
  for (const f of parsed.files ?? []) {
    // Map the model's path back to a known key (it should echo what we gave it).
    const key =
      [...files.keys()].find((k) => k === f.path) ||
      [...files.keys()].find((k) => k.endsWith(f.path));
    if (key && typeof f.content === 'string') {
      files.set(key, f.content);
      changed.push(key);
    }
  }
  return { changed, note: parsed.note ?? `LLM changed ${changed.length} file(s).` };
}

export async function runAgentLoop(opts: LoopOptions): Promise<LoopResult> {
  const {
    sessionId,
    appId,
    version = '1.0.0',
    includeWarnings = true,
    llmOnly = false,
    onEvent,
  } = opts;
  // Explicit opts.maxIterations wins; otherwise AGENT_INSPECT_MAX_ITERATIONS, else 4.
  const maxIterations = resolveInspectMaxIterations(opts.maxIterations);
  const useLlm = opts.useLlm ?? !!openRouterApiKey();

  const events: LoopEvent[] = [];
  const emit = (
    kind: LoopEventKind,
    iteration: number,
    message: string,
    data?: Record<string, unknown>
  ) => {
    const e: LoopEvent = { kind, iteration, ts: new Date().toISOString(), message, data };
    events.push(e);
    onEvent?.(e);
    void traceLogger.log({
      sessionId,
      kind: 'note',
      name: `loop.${kind}`,
      payload: { iteration, message, ...(data ?? {}) },
    });
  };

  // Working source map keyed by loop path.
  const files = new Map<string, string>();
  for (const f of opts.files) files.set(f.path, f.content);

  // Normalise: globalConfig.json must live at the add-on ROOT, never under
  // package/. Agents sometimes mistakenly write `package/globalConfig.json`; it
  // is always invalid (ucc-gen reads the root one) and, left in place, can shadow
  // the real file in fixers that match by suffix. Drop the stray copy up-front.
  for (const key of [...files.keys()]) {
    const norm = key.replace(/^\/+/, '');
    if (/(^|\/)package\/globalConfig\.json$/.test(norm)) {
      files.delete(key);
      emit(
        'fix',
        0,
        `Removed stray ${key} (globalConfig.json must be at the add-on root, not under package/).`
      );
    }
  }

  emit(
    'start',
    0,
    `Starting agentic loop for ${appId} (maxIterations=${maxIterations}, includeWarnings=${includeWarnings}, llm=${useLlm}).`
  );

  let tarball: string | undefined;
  let finalReport: AppInspectReport | undefined;
  let finalSummary: string | undefined;
  let clean = false;
  let iteration = 0;
  // Signature of the previous iteration's actionable findings. If a fix runs but
  // the next AppInspect produces the IDENTICAL set of findings, the fix changed
  // nothing — break early instead of grinding to maxIterations re-fixing the same
  // thing. (Distinct from the changedThisRound==0 guard, which only catches the
  // case where no fixer touched a file at all.)
  let prevFindingsSignature: string | null = null;
  // Build-error no-progress breaker: the previous iteration's build-error text. If a
  // build-error fix reports it changed nothing (`changed: []`) AND the build fails
  // again with the identical error, no progress was made — stop rather than grind to
  // the iteration cap. The manifest guard prevents the common case; this is the
  // safety net for any future no-op build-error fix loop.
  let prevBuildError: string | null = null;
  let sameBuildErrorStreak = 0;

  for (iteration = 1; iteration <= maxIterations; iteration++) {
    emit('iteration', iteration, `--- Iteration ${iteration} ---`);

    // Fresh workdir each iteration (deterministic, no stale output).
    const workDir = await fileHandler.createTempDirectory(
      `loop-${sessionId}-${iteration}-${Date.now()}`
    );
    const onDisk = [...files.entries()].map(([p, content]) => ({ path: p, content }));
    await fileHandler.writeFiles(workDir, onDisk);

    // 1. Build + package via ucc-gen.
    const buildLogs: string[] = [];
    try {
      await ucc.init(workDir, appId, (l) => buildLogs.push(l));
      const outputDir = await ucc.build(workDir, (l) => buildLogs.push(l), version);
      const builtAppPath = path.join(outputDir, appId);
      tarball = await ucc.package(workDir, builtAppPath, (l) => buildLogs.push(l));
      emit('build', iteration, `ucc-gen build + package OK -> ${path.basename(tarball)}`, {
        tarball,
      });
    } catch (err) {
      const msg = (err as Error).message;
      const fullLog = buildLogs.join('\n');
      emit('build_error', iteration, `Build failed: ${msg}`, { logs: buildLogs.slice(-15) });

      // No-progress breaker: if THIS build error is identical to the previous
      // iteration's AND the last fix changed nothing, we're looping on an
      // un-fixable error — stop instead of grinding to maxIterations.
      const buildErrorSignature = `${msg}\n${buildLogs.slice(-15).join('\n')}`;
      const sameAsPrev = prevBuildError !== null && prevBuildError === buildErrorSignature;
      prevBuildError = buildErrorSignature;
      sameBuildErrorStreak = sameAsPrev ? sameBuildErrorStreak + 1 : 1;

      // Hard stuck-loop breaker: the identical build error 3 iterations running
      // means two fixes (even ones that DID change files) failed to move the
      // needle — e.g. the LLM rewriting app.manifest with the same wrong content
      // each time. Stop burning iterations (and LLM credit) on it.
      if (sameBuildErrorStreak >= 3) {
        emit(
          'exhausted',
          iteration,
          'No progress — the identical build error occurred 3 iterations in a row despite fix attempts. Stopping; fix the reported file manually.',
          { error: msg }
        );
        break;
      }

      // Deterministic build-error fixes (free, instant) before falling to the LLM.
      const det = deterministicBuildFix(fullLog, files, appId);
      if (det) {
        if (det.changed.length === 0 && sameAsPrev) {
          emit(
            'exhausted',
            iteration,
            `No progress — the build-error fix changed nothing and the build failed with the identical error. Stopping.`,
            { error: msg }
          );
          break;
        }
        emit('fix', iteration, `[rule] build-error: ${det.note}`, { changed: det.changed });
        continue;
      }

      // Otherwise let the LLM try to fix the build error.
      if (useLlm) {
        try {
          const synthetic: AppInspectCheck = {
            check: 'ucc_gen_build_error',
            result: 'failure',
            message: msg,
            description: 'ucc-gen build failed. Fix the source so the add-on builds.',
            messages: [{ message: `${msg}\n\n${buildLogs.slice(-15).join('\n')}` }],
          };
          const res = await llmFix([synthetic], files, appId);
          // A no-op LLM fix (changed: []) on an unchanged build error means the
          // model "claimed" a fix but wrote nothing — exactly the loop the live
          // trace hit. Break rather than re-prompt the same failure to the cap.
          if (res.changed.length === 0 && sameAsPrev) {
            emit(
              'exhausted',
              iteration,
              `No progress — the build-error fix changed nothing (changed: []) and the build failed with the identical error. Stopping.`,
              { error: msg }
            );
            break;
          }
          emit('fix', iteration, `LLM build-error fix: ${res.note}`, { changed: res.changed });
          continue;
        } catch (e) {
          emit('fix_skipped', iteration, `LLM build-error fix failed: ${(e as Error).message}`);
          break;
        }
      }
      break;
    }

    // 2. AppInspect.
    const report = await appInspect.inspectTarball(tarball);
    finalReport = report;
    finalSummary = appInspect.summarise(report, includeWarnings);
    const actionable = appInspect.actionableChecks(report, includeWarnings);
    emit('inspect', iteration, `AppInspect: ${actionable.length} actionable check(s).`, {
      summary: report.summary,
      source: report.source,
      actionable: actionable.map((c) => ({ check: c.check, result: c.result })),
    });

    if (report.source === 'stub') {
      emit(
        'done',
        iteration,
        'AppInspect unavailable (stub) — cannot self-correct. Install splunk-appinspect.'
      );
      break;
    }

    // 3. Clean?
    if (actionable.length === 0) {
      clean = true;
      emit(
        'clean',
        iteration,
        `Package is AppInspect-clean (no ${includeWarnings ? 'failures/warnings' : 'failures'}).`
      );
      break;
    }

    // No-progress breaker: if this iteration's findings are byte-identical to the
    // previous iteration's, the last fix changed nothing — stop rather than loop.
    const findingsSignature = JSON.stringify(
      actionable
        .map((c) => ({
          check: c.check,
          result: c.result,
          messages: (c.messages ?? []).map(
            (m) => `${m.message ?? ''}@${m.message_filename ?? ''}:${m.message_line ?? ''}`
          ),
        }))
        .sort((a, b) => a.check.localeCompare(b.check))
    );
    if (iteration > 1 && prevFindingsSignature === findingsSignature) {
      emit(
        'exhausted',
        iteration,
        `No progress — the previous fix did not change the AppInspect findings (${actionable.length} unchanged check(s)). Stopping.`,
        {
          actionable: actionable.map((c) => ({ check: c.check, result: c.result })),
        }
      );
      break;
    }
    prevFindingsSignature = findingsSignature;

    if (iteration === maxIterations) {
      emit(
        'exhausted',
        iteration,
        `Reached maxIterations with ${actionable.length} unresolved check(s).`
      );
      break;
    }

    // 4. Fix — deterministic rules first, collect what's left for the LLM.
    const changedThisRound = new Set<string>();
    const unresolved: AppInspectCheck[] = [];
    for (const c of actionable) {
      const det = llmOnly ? null : deterministicFix(c, files, appId);
      if (det) {
        det.changed.forEach((k) => changedThisRound.add(k));
        emit('fix', iteration, `[rule] ${c.check}: ${det.note}`, { changed: det.changed });
      } else {
        unresolved.push(c);
      }
    }

    if (unresolved.length && useLlm) {
      try {
        const res = await llmFix(unresolved, files, appId);
        res.changed.forEach((k) => changedThisRound.add(k));
        emit('fix', iteration, `[llm] ${res.note}`, {
          changed: res.changed,
          checks: unresolved.map((c) => c.check),
        });
      } catch (e) {
        emit('fix_skipped', iteration, `LLM fix failed: ${(e as Error).message}`, {
          checks: unresolved.map((c) => c.check),
        });
      }
    } else if (unresolved.length) {
      emit(
        'fix_skipped',
        iteration,
        `${unresolved.length} check(s) need an LLM fix but no key/useLlm is set.`,
        {
          checks: unresolved.map((c) => c.check),
        }
      );
    }

    if (changedThisRound.size === 0) {
      emit(
        'exhausted',
        iteration,
        'No fixer could change anything this round — stopping to avoid an infinite loop.'
      );
      break;
    }
  }

  emit('done', iteration, clean ? 'Loop finished: CLEAN.' : 'Loop finished: not clean.', { clean });

  return {
    ok: true,
    clean,
    iterations: iteration,
    appId,
    tarball,
    finalSummary,
    finalReport,
    files: [...files.entries()].map(([p, content]) => ({ path: p, content })),
    events,
  };
}
