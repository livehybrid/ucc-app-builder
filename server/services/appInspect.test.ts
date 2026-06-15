import { describe, it, expect } from 'vitest';
import { AppInspectService, AppInspectReport } from './appInspect.js';

function report(checks: AppInspectReport['checks']): AppInspectReport {
  return { summary: {}, checks, raw: '', source: 'cli' };
}

describe('AppInspectService policy', () => {
  const svc = new AppInspectService();

  it('treats failures and errors as actionable regardless of includeWarnings', () => {
    const r = report([
      { check: 'a', result: 'failure', message: 'x' },
      { check: 'b', result: 'error', message: 'y' },
      { check: 'c', result: 'success', message: '' },
    ]);
    expect(svc.actionableChecks(r, false).map((c) => c.check)).toEqual(['a', 'b']);
    expect(svc.isClean(r)).toBe(false);
  });

  it('includes fixable warnings but filters known-informational UCC noise', () => {
    const r = report([
      { check: 'check_for_updates_disabled', result: 'warning', message: 'fixable' },
      { check: 'check_for_ucc_framework_version', result: 'warning', message: 'noise' },
      { check: 'check_for_modular_inputs', result: 'warning', message: 'noise' },
    ]);
    const actionable = svc.actionableChecks(r, true).map((c) => c.check);
    expect(actionable).toEqual(['check_for_updates_disabled']);
  });

  it('excludes all warnings when includeWarnings is false', () => {
    const r = report([{ check: 'check_for_updates_disabled', result: 'warning', message: 'w' }]);
    expect(svc.actionableChecks(r, false)).toHaveLength(0);
    expect(svc.isClean(r, false)).toBe(true);
  });

  it('is clean when only informational warnings remain', () => {
    const r = report([
      { check: 'check_for_splunk_js', result: 'warning', message: 'ignore me' },
      { check: 'check_for_python_script_existence', result: 'warning', message: 'ignore me' },
    ]);
    expect(svc.isClean(r, true)).toBe(true);
  });

  it('treats a vendor-lib-scoped warning as informational only when ALL messages are in lib/ or the ucc-gen JS bundle', () => {
    // Entirely vendored -> ignored.
    const vendored = report([
      {
        check: 'check_for_possible_threading',
        result: 'warning',
        message: 'x',
        messages: [{ message: 'x', message_filename: 'lib/solnlib/splunkenv.py', message_line: 344 }],
      },
      {
        check: 'check_hostnames_and_ips',
        result: 'warning',
        message: 'ip',
        messages: [
          { message: 'ip', message_filename: 'lib/PySocks-1.7.1.dist-info/METADATA', message_line: 70 },
          { message: 'ip', message_filename: 'appserver/static/js/build/Dashboard.abc.js', message_line: 91 },
        ],
      },
    ]);
    expect(svc.actionableChecks(vendored, true)).toHaveLength(0);
  });

  it('keeps a vendor-lib-scoped warning ACTIONABLE when it fires on the author\'s own bin/ source', () => {
    const authorSource = report([
      {
        check: 'check_for_supported_tls',
        result: 'warning',
        message: 'tls',
        messages: [{ message: 'tls', message_filename: 'bin/my_input.py', message_line: 12 }],
      },
    ]);
    expect(svc.actionableChecks(authorSource, true).map((c) => c.check)).toEqual(['check_for_supported_tls']);
  });

  it('summarise lists actionable checks with file/line context', () => {
    const r = report([
      {
        check: 'check_for_updates_disabled',
        result: 'warning',
        message: 'set false',
        messages: [{ message: 'set false', message_filename: 'default/app.conf', message_line: 8 }],
      },
    ]);
    const s = svc.summarise(r, true);
    expect(s).toContain('check_for_updates_disabled');
    expect(s).toContain('default/app.conf:8');
  });
});
