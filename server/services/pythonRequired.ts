/**
 * Estate policy for python.required: every python extension point declares
 * `python.required = 3.13` (plus `python.version = python3`). AppInspect 4.4
 * promoted check_*_python_required from future_failure to FAILURE, accepting
 * only 3.13 / 3.14.
 */
export const REQUIRED_PYTHON_VERSIONS = ['3.13'];
const ACCEPTED_PYTHON_REQUIRED = new Set(['3.13', '3.14']);

/** check_modular_inputs_python_required, check_commands_conf_python_required, ... */
export function isPythonRequiredCheck(name: string): boolean {
  return /^check_\w+_python_required$/.test(name);
}

/** True when meta.supportedPythonVersion is non-empty and every entry is 3.13/3.14. */
export function supportedPythonCompliant(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((x) => ACCEPTED_PYTHON_REQUIRED.has(String(x).trim()))
  );
}

/**
 * Add/replace `python.required` (and add `python.version = python3` when absent)
 * in stanza `[stanza]` of a hand-written .conf. Returns the new text, or null if
 * the stanza is not in this file or is already compliant.
 */
export function setPythonRequiredInStanza(conf: string, stanza: string): string | null {
  const lines = conf.split('\n');
  const header = `[${stanza}]`;
  const start = lines.findIndex((l) => l.trim() === header);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  const body = lines.slice(start + 1, end);
  const reqIdx = body.findIndex((l) => /^\s*python\.required\s*=/.test(l));
  const hasVersion = body.some((l) => /^\s*python\.version\s*=/.test(l));
  const want = `python.required = ${REQUIRED_PYTHON_VERSIONS.join(', ')}`;
  if (reqIdx !== -1) {
    const current = body[reqIdx]
      .split('=')
      .slice(1)
      .join('=')
      .split(',')
      .map((x) => x.trim());
    if (hasVersion && current.length && current.every((x) => ACCEPTED_PYTHON_REQUIRED.has(x))) {
      return null;
    }
    body[reqIdx] = want;
  } else {
    body.unshift(want);
  }
  if (!hasVersion) body.unshift('python.version = python3');
  return [...lines.slice(0, start + 1), ...body, ...lines.slice(end)].join('\n');
}
