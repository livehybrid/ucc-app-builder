import { spawn, spawnSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

/**
 * Splunk AppInspect wrapper.
 *
 * Prefers the `splunk-appinspect` CLI (pip-installable) when available. Falls
 * back to the public AppInspect REST API when `APPINSPECT_TOKEN` is set.
 *
 * Returns structured check results so the agent can iterate.
 */

export interface AppInspectMessage {
  message: string;
  message_filename?: string;
  message_line?: number;
  filename?: string;
  line?: number;
  result?: string;
  code?: string;
}

export interface AppInspectCheck {
  /** Check id, e.g. `check_for_updates_disabled`. */
  check: string;
  /** Human-readable description of what the check verifies. */
  description?: string;
  result: 'success' | 'failure' | 'manual_check' | 'warning' | 'skipped' | 'not_applicable' | 'error';
  /** Flattened first message (back-compat convenience). */
  message: string;
  /** All messages emitted by the check (file + line context for the fixer). */
  messages?: AppInspectMessage[];
  tags?: string[];
}

/**
 * Raw check shape as emitted by `splunk-appinspect` JSON output:
 *   { name, description, result, tags, messages: [{ message, message_filename, message_line, ... }] }
 * We normalise it to AppInspectCheck (with `check` + flattened `message`).
 */
interface RawAppInspectCheck {
  name?: string;
  check?: string;
  description?: string;
  result: AppInspectCheck['result'];
  tags?: string[];
  messages?: AppInspectMessage[];
  message?: string;
}

function normaliseCheck(raw: RawAppInspectCheck): AppInspectCheck {
  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  const firstMessage = messages[0]?.message ?? raw.message ?? '';
  return {
    check: raw.name ?? raw.check ?? 'unknown_check',
    description: raw.description,
    result: raw.result,
    message: firstMessage,
    messages,
    tags: raw.tags,
  };
}

export interface AppInspectReport {
  summary: Record<string, number>;
  checks: AppInspectCheck[];
  raw: string;
  source: 'cli' | 'api' | 'stub';
}

function run(cmd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('close', (code) => resolve({ code: code ?? -1, out, err }));
    p.on('error', (e) => resolve({ code: -1, out, err: err + '\n' + e.message }));
  });
}

export class AppInspectService {
  cliAvailable(): boolean {
    try {
      // `splunk-appinspect` has no `--version` flag; the version lives behind a
      // subcommand. `list version` exits 0 and prints e.g. "Splunk AppInspect Version 4.2.1".
      const res = spawnSync('splunk-appinspect', ['list', 'version'], { encoding: 'utf-8' });
      return res.status === 0;
    } catch {
      return false;
    }
  }

  async inspectTarball(tarballPath: string): Promise<AppInspectReport> {
    const abs = path.resolve(tarballPath);
    await fs.access(abs);

    if (this.cliAvailable()) {
      return this.inspectViaCli(abs);
    }
    if (process.env.APPINSPECT_TOKEN) {
      return this.inspectViaApi(abs);
    }
    return {
      summary: { skipped: 1 },
      checks: [],
      raw:
        'AppInspect skipped: neither the `splunk-appinspect` CLI nor APPINSPECT_TOKEN env var are available. ' +
        'Install with `pip install splunk-appinspect` or export APPINSPECT_TOKEN.',
      source: 'stub',
    };
  }

  private async inspectViaCli(abs: string): Promise<AppInspectReport> {
    // Unique output file per run so concurrent loop iterations don't clobber each other.
    const outFile = path.join(
      process.env.TMPDIR || '/tmp',
      `appinspect-${path.basename(abs)}-${Date.now()}.json`,
    );
    const res = await run('splunk-appinspect', [
      'inspect', abs,
      '--output-file', outFile,
      '--mode', 'precert',
    ]);
    const raw = (res.out + '\n' + res.err).trim();
    let summary: Record<string, number> = {};
    const checks: AppInspectCheck[] = [];
    try {
      const text = await fs.readFile(outFile, 'utf-8');
      const parsed = JSON.parse(text) as {
        summary?: Record<string, number>;
        reports?: Array<{ groups: Array<{ checks: RawAppInspectCheck[] }> }>;
      };
      if (parsed.summary) summary = parsed.summary;
      for (const report of parsed.reports ?? []) {
        for (const group of report.groups) {
          for (const c of group.checks) checks.push(normaliseCheck(c));
        }
      }
    } catch {
      // Report file missing — leave empty.
    } finally {
      fs.unlink(outFile).catch(() => undefined);
    }
    return { summary, checks, raw, source: 'cli' };
  }

  private async inspectViaApi(abs: string): Promise<AppInspectReport> {
    const token = process.env.APPINSPECT_TOKEN!;
    const buf = await fs.readFile(abs);
    const form = new FormData();
    form.append('app_package', new Blob([buf]), path.basename(abs));
    const submitRes = await fetch('https://appinspect.splunk.com/v1/app/validate', {
      method: 'POST',
      headers: { Authorization: `bearer ${token}` },
      body: form as unknown as BodyInit,
    });
    if (!submitRes.ok) {
      throw new Error(`AppInspect submit failed: ${submitRes.status} ${submitRes.statusText}`);
    }
    const submit = await submitRes.json() as { request_id: string };
    // Poll.
    const start = Date.now();
    while (Date.now() - start < 300_000) {
      await new Promise((r) => setTimeout(r, 5000));
      const statusRes = await fetch(
        `https://appinspect.splunk.com/v1/app/validate/status/${submit.request_id}`,
        { headers: { Authorization: `bearer ${token}` } },
      );
      const status = await statusRes.json() as { status: string };
      if (status.status === 'SUCCESS') break;
      if (status.status === 'ERROR') throw new Error('AppInspect status=ERROR');
    }
    const reportRes = await fetch(
      `https://appinspect.splunk.com/v1/app/report/${submit.request_id}`,
      {
        headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json' },
      },
    );
    const report = await reportRes.json() as {
      summary: Record<string, number>;
      reports: Array<{ groups: Array<{ checks: RawAppInspectCheck[] }> }>;
    };
    const checks: AppInspectCheck[] = [];
    for (const r of report.reports) for (const g of r.groups) for (const c of g.checks) checks.push(normaliseCheck(c));
    return { summary: report.summary, checks, raw: JSON.stringify(report.summary), source: 'api' };
  }

  /**
   * Warnings that splunk-appinspect emits for *correctly built* UCC add-ons and
   * which it explicitly tells you to ignore ("No action required" / "please
   * disregard"). The self-correcting loop must NOT chase these or it can never
   * reach a clean state. They are informational, not defects in the source.
   */
  static readonly INFORMATIONAL_CHECKS = new Set<string>([
    'check_for_ucc_framework_version', // "UCC framework usage detected. version = X"
    'check_for_modular_inputs', // "App contains modular inputs ... No action required"
    'check_for_python_script_existence', // py2/3 compat advisory on UCC-generated bin/
    'check_for_splunk_js', // telemetry notice on UCC-bundled JS; "please ignore"
    'check_for_splunk_js_header_and_footer_view', // deprecation notice on UCC JS bundle
    'check_for_indexer_synced_configs', // Victoria sync advisory on inputs.conf
    // Telemetry notices Splunk explicitly tells you to ignore (UDF / Splunk UI bundles
    // that ucc-gen ships in appserver/static/js/build):
    'check_for_splunk_dashboard_core',
    'check_for_splunk_frontend_utility_components',
    'check_for_splunk_sui',
    // Advisories about the packaged third-party dependency versions UCC installs into
    // lib/ — not defects in the add-on source ("No action required"):
    'check_ucc_dependencies', // "Detected splunktaucclib/solnlib (version X). No action required."
    'check_python_sdk_version', // advisory about the bundled Splunk SDK for Python version
  ]);

  /**
   * Checks that are only informational when EVERY message points at code the add-on
   * author did NOT write and cannot fix: the vendored third-party libraries under
   * `lib/` (solnlib, splunktaucclib, PySocks, the Splunk SDK, etc.) or the JS bundle
   * ucc-gen emits under `appserver/static/js/build/`. The SAME check is genuinely
   * actionable if it fires on the author's own `bin/` source, so we cannot
   * blanket-ignore it by name; we ignore it only when it is entirely generated/vendored.
   */
  static readonly VENDOR_LIB_SCOPED_CHECKS = new Set<string>([
    'check_for_possible_threading', // subprocess/threading advisory (fires on lib/solnlib)
    'check_for_supported_tls', // TLS-verification advisory (fires on lib/solnlib/rest.py)
    'check_hostnames_and_ips', // IPs inside vendored lib/ dist-info + ucc-gen JS bundle
  ]);

  /** Paths the add-on author does not own: vendored deps + ucc-gen-emitted JS bundle. */
  private static isGeneratedOrVendoredPath(f: string): boolean {
    return /(^|\/)lib\//.test(f) || /appserver\/static\/js\/build\//.test(f);
  }

  /** True if every message location for a check is generated/vendored (not author source). */
  private static allMessagesInVendorLib(check: AppInspectCheck): boolean {
    const msgs = check.messages ?? [];
    if (msgs.length === 0) return false;
    return msgs.every((m) => {
      const f = m.message_filename || m.filename || '';
      return AppInspectService.isGeneratedOrVendoredPath(f);
    });
  }

  /** Checks the agentic fix-loop should try to resolve. Failures/errors always; fixable warnings when `includeWarnings`. */
  actionableChecks(report: AppInspectReport, includeWarnings = true): AppInspectCheck[] {
    return report.checks.filter((c) => {
      if (c.result === 'failure' || c.result === 'error') return true;
      if (includeWarnings && c.result === 'warning') {
        if (AppInspectService.INFORMATIONAL_CHECKS.has(c.check)) return false;
        // Vendor-lib-scoped checks are informational ONLY when every finding is in lib/.
        if (
          AppInspectService.VENDOR_LIB_SCOPED_CHECKS.has(c.check) &&
          AppInspectService.allMessagesInVendorLib(c)
        ) {
          return false;
        }
        return true;
      }
      return false;
    });
  }

  /** True when the package has zero failures/errors (and zero warnings if includeWarnings). */
  isClean(report: AppInspectReport, includeWarnings = true): boolean {
    return this.actionableChecks(report, includeWarnings).length === 0;
  }

  summarise(report: AppInspectReport, includeWarnings = true): string {
    const parts: string[] = [];
    parts.push(`AppInspect (${report.source}):`);
    if (Object.keys(report.summary).length) {
      parts.push(
        Object.entries(report.summary)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join('\n'),
      );
    }
    const actionable = this.actionableChecks(report, includeWarnings);
    if (actionable.length) {
      parts.push('Actionable checks (fix these):');
      for (const f of actionable.slice(0, 30)) {
        const loc = f.messages?.[0]?.message_filename
          ? ` [${f.messages[0].message_filename}:${f.messages[0].message_line ?? '?'}]`
          : '';
        parts.push(`  - (${f.result}) ${f.check}: ${f.message}${loc}`);
      }
    }
    if (!actionable.length && !Object.keys(report.summary).length) {
      parts.push(report.raw);
    }
    return parts.join('\n');
  }
}
