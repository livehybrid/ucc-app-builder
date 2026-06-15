import { Tool } from '../toolTypes';

interface ConformanceIssue {
  severity: 'error' | 'warning';
  message: string;
}

function findInputScriptPath(files: string[], appRoot: string, inputName: string): string | null {
  const normalizedRoot = appRoot.replace(/\/+$/, '');
  const exact = `${normalizedRoot}/package/bin/${inputName}.py`;
  return files.includes(exact) ? exact : null;
}

function findInputHelperPath(files: string[], appRoot: string, inputName: string): string | null {
  const normalizedRoot = appRoot.replace(/\/+$/, '');
  const exact = `${normalizedRoot}/package/bin/${inputName}_helper.py`;
  return files.includes(exact) ? exact : null;
}

export const validateUccConformance: Tool = {
  name: 'validate_ucc_conformance',
  description:
    'Validate that current files follow UCC/Splunk app patterns (globalConfig, modular inputs, helper scripts, and UCC imports).',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  execute: async (_args, vfs) => {
    const issues: ConformanceIssue[] = [];
    const files = vfs.listAllFiles().map((f) => f.path);

    const globalConfigPath =
      files.find((p) => p.endsWith('/globalConfig.json')) ||
      files.find((p) => p === 'globalConfig.json');
    if (!globalConfigPath) {
      return 'Conformance check failed: globalConfig.json not found.';
    }

    const appRoot = globalConfigPath.endsWith('/globalConfig.json')
      ? globalConfigPath.slice(0, -'/globalConfig.json'.length)
      : '';

    const globalConfigRaw = vfs.readFile(globalConfigPath);
    if (!globalConfigRaw) {
      return `Conformance check failed: unable to read ${globalConfigPath}.`;
    }

    let globalConfig: Record<string, unknown>;
    try {
      globalConfig = JSON.parse(globalConfigRaw);
    } catch (e) {
      return `Conformance check failed: globalConfig.json is invalid JSON (${String(e)}).`;
    }

    const pages = (globalConfig.pages || {}) as Record<string, unknown>;
    const inputsPage = (pages.inputs || {}) as Record<string, unknown>;
    const services = Array.isArray(inputsPage.services) ? inputsPage.services : [];
    if (!services.length) {
      issues.push({
        severity: 'warning',
        message: 'No modular input services defined in globalConfig.pages.inputs.services.',
      });
    }

    for (const service of services) {
      const inputName = String((service as Record<string, unknown>).name || '').trim();
      if (!inputName) {
        issues.push({ severity: 'error', message: 'Found an input service without a "name".' });
        continue;
      }

      const scriptPath = findInputScriptPath(files, appRoot, inputName);
      const helperPath = findInputHelperPath(files, appRoot, inputName);

      if (!scriptPath) {
        issues.push({
          severity: 'error',
          message: `Missing main modular input script for "${inputName}" at package/bin/${inputName}.py.`,
        });
      } else {
        const script = vfs.readFile(scriptPath) || '';
        if (!script.includes('base_modinput') && !script.includes('Script')) {
          issues.push({
            severity: 'error',
            message: `${scriptPath} does not appear to use UCC BaseModInput or splunklib Script patterns.`,
          });
        }
        if (!script.includes('import_declare_test')) {
          issues.push({
            severity: 'warning',
            message: `${scriptPath} should import import_declare_test for Splunk app library path compatibility.`,
          });
        }
      }

      if (!helperPath) {
        issues.push({
          severity: 'warning',
          message: `Missing helper module for "${inputName}" at package/bin/${inputName}_helper.py.`,
        });
      } else {
        const helper = vfs.readFile(helperPath) || '';
        if (!helper.includes('def stream_events(') && !helper.includes('def collect_events(')) {
          issues.push({
            severity: 'warning',
            message: `${helperPath} should expose stream/collect entrypoints expected by UCC-generated wrappers.`,
          });
        }
      }
    }

    if (!files.some((p) => p.endsWith('/package/default/app.conf'))) {
      issues.push({ severity: 'error', message: 'Missing package/default/app.conf.' });
    }
    if (!files.some((p) => p.endsWith('/package/metadata/default.meta'))) {
      issues.push({ severity: 'warning', message: 'Missing package/metadata/default.meta.' });
    }

    const errors = issues.filter((i) => i.severity === 'error');
    const warnings = issues.filter((i) => i.severity === 'warning');

    if (!issues.length) {
      return 'UCC conformance: PASS. No issues detected.';
    }

    const lines = [
      `UCC conformance: ${errors.length ? 'FAIL' : 'PASS WITH WARNINGS'}`,
      `Errors: ${errors.length}, Warnings: ${warnings.length}`,
      '',
      ...issues.map((i) => `- [${i.severity.toUpperCase()}] ${i.message}`),
    ];
    return lines.join('\n');
  },
};
