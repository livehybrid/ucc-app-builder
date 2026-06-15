/**
 * Deterministic generator for a **pytest-splunk-addon** test scaffold - the validation
 * half of the data loop. The input emulator (Test Input) shows the RAW events an input
 * produces; the user then authors props.conf / transforms.conf; this scaffold lets them
 * prove those knowledge objects with pytest-splunk-addon's standard test suite (sourcetype/
 * source/index assignment, field extractions, and CIM data-model compliance) against a
 * real Splunk - no hand-written test code.
 *
 * Like the dashboard/savedsearch generators, this is a pure, LLM-free emitter: a calling
 * agent passes the add-on's sourcetypes (and optionally sample events captured from the
 * emulator) and we produce the exact files pytest-splunk-addon expects.
 *
 * Exposed behind the `generate_tests` MCP tool and the in-app "Generate tests" action.
 */

export interface SourcetypeTestSpec {
  /** Sourcetype to validate, e.g. "weatherapi:observation". */
  sourcetype: string;
  /** Source name; defaults to the sourcetype. */
  source?: string;
  /** Destination index for the generated events (defaults to "main"). */
  index?: string;
  /**
   * pytest-splunk-addon input_type for the sample stanza - how Splunk would ingest these
   * events. Defaults to "modinput" (UCC/AOB modular inputs).
   */
  inputType?: 'modinput' | 'scripted_input' | 'file_monitor' | 'uf_file_monitor' | 'syslog_tcp' | 'default';
  /** CIM data model(s) this sourcetype should comply with (documented in the README). */
  cimDataModels?: string[];
  /**
   * Raw sample events (one per array entry) - e.g. captured by the input emulator. Seeded
   * verbatim into the .sample file; when omitted a clearly-marked placeholder is written.
   */
  sampleEvents?: string[];
}

export interface PytestScaffoldSpec {
  /** The add-on id, e.g. "ta_weatherapi". */
  addonName: string;
  sourcetypes: SourcetypeTestSpec[];
}

export interface ScaffoldFile {
  path: string;
  content: string;
}

/** A filesystem-safe token from an arbitrary name (sourcetype, addon id, …). */
function safeName(s: string): string {
  return (
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'sample'
  );
}

/** The sample file name for a sourcetype, e.g. "weatherapi:obs" -> "weatherapi_obs.sample". */
export function sampleFileName(sourcetype: string): string {
  return `${safeName(sourcetype)}.sample`;
}

/** Build the eventgen-style `pytest-splunk-addon-data.conf` stanzas for the sourcetypes. */
export function buildDataConf(spec: PytestScaffoldSpec): string {
  const blocks = spec.sourcetypes.map((st) => {
    const file = sampleFileName(st.sourcetype);
    const count = st.sampleEvents && st.sampleEvents.length ? st.sampleEvents.length : 1;
    return [
      `[${file}]`,
      `sourcetype = ${st.sourcetype}`,
      `source = ${st.source || st.sourcetype}`,
      `sourcetype_to_search = ${st.sourcetype}`,
      `host_type = plugin`,
      `input_type = ${st.inputType || 'modinput'}`,
      `index = ${st.index || 'main'}`,
      // plugin timestamps assign each event a fresh _time at generation, so samples never
      // fall outside the search window - no per-sample timestamp token needed to get started.
      `timestamp_type = plugin`,
      `count = ${count}`,
      `expected_event_count = ${count}`,
    ].join('\n');
  });
  return blocks.join('\n\n') + '\n';
}

const PLACEHOLDER_EVENT =
  '{"replace_me": "Paste a real sample event here - one event per line. Tip: use Test Input to capture real events, then drop them in."}';

/** Build the `.sample` files (one per sourcetype) from captured sample events. */
export function buildSampleFiles(spec: PytestScaffoldSpec): ScaffoldFile[] {
  return spec.sourcetypes.map((st) => {
    const lines =
      st.sampleEvents && st.sampleEvents.length
        ? st.sampleEvents.map((e) => String(e).replace(/\r?\n/g, ' '))
        : [PLACEHOLDER_EVENT];
    return {
      path: `tests/data/samples/${sampleFileName(st.sourcetype)}`,
      content: lines.join('\n') + '\n',
    };
  });
}

/** The Basic-subclass test module that triggers pytest-splunk-addon's standard suite. */
function buildTestModule(addonName: string): string {
  const cls = 'Test_' + (safeName(addonName).replace(/(^|_)([a-z])/g, (_m, _s, c) => c.toUpperCase()) || 'Addon');
  return `"""
pytest-splunk-addon entry point for ${addonName}.

Subclassing Basic registers the framework's standard tests - sourcetype / source / index
assignment, field extractions (props.conf / transforms.conf) and CIM data-model compliance -
generated from the sample events under tests/data/. You do not write the assertions; the
plugin does, driven by the .sample files and your knowledge objects.

Docs: https://splunk.github.io/pytest-splunk-addon/
"""
from pytest_splunk_addon.standard_lib.addon_basic import Basic


class ${cls}(Basic):
    def empty_method(self):
        pass
`;
}

function buildPytestIni(): string {
  return `[pytest]
# Connection + app/data-generator paths are passed on the CLI (see README.md) so this file
# stays portable across environments. -ra surfaces a summary of skips/xfails.
addopts = -ra -v
`;
}

function buildRequirements(): string {
  return `# Validation harness for this add-on's knowledge objects (props/transforms/CIM).
# Pinned to the 5.x line; see https://splunk.github.io/pytest-splunk-addon/ for the matrix.
pytest-splunk-addon>=5.0,<6.0
pytest>=7.0
`;
}

function buildReadme(spec: PytestScaffoldSpec): string {
  const sts = spec.sourcetypes
    .map((st) => {
      const cim = st.cimDataModels && st.cimDataModels.length ? ` - CIM: ${st.cimDataModels.join(', ')}` : '';
      return `- \`${st.sourcetype}\` (samples: \`tests/data/samples/${sampleFileName(st.sourcetype)}\`)${cim}`;
    })
    .join('\n');
  return `# Tests - ${spec.addonName}

Automated validation of this add-on's knowledge objects with
[pytest-splunk-addon](https://splunk.github.io/pytest-splunk-addon/): it ingests the sample
events below into a real Splunk and asserts sourcetype/source/index assignment, field
extractions (props.conf / transforms.conf) and CIM data-model compliance - no hand-written
test code.

## The data loop

1. **See the data** - use **Test Input** (the input emulator) to run an input and capture
   the real events it produces.
2. **Model it** - author \`props.conf\` / \`transforms.conf\` (field extractions, sourcetype
   assignment, CIM aliases/eval).
3. **Prove it** - drop the captured events into \`tests/data/samples/*.sample\` and run the
   suite below. Iterate until green.

## Sourcetypes under test

${sts}

## Running

\`\`\`bash
pip install -r tests/requirements.txt

# Build the add-on first (ucc-gen build / Download Source), then point --splunk-app at it.
pytest tests/ \\
  --splunk-app=/path/to/built/${spec.addonName} \\
  --splunk-data-generator=tests/data \\
  --splunk-type=external \\
  --splunk-host=<host> --splunk-port=8089 \\
  --splunk-user=admin --splunk-password=<pw>
\`\`\`

To validate CIM compliance only, add \`-m "splunk_searchtime_cim"\`; for field extractions,
\`-m "splunk_searchtime_fields"\`. See the plugin docs for the full marker list.
`;
}

/** Build the full pytest-splunk-addon scaffold file set for an add-on. */
export function buildPytestScaffold(spec: PytestScaffoldSpec): { files: ScaffoldFile[] } {
  if (!spec.addonName || !spec.addonName.trim()) {
    throw new Error('addonName is required');
  }
  if (!Array.isArray(spec.sourcetypes) || spec.sourcetypes.length === 0) {
    throw new Error('at least one sourcetype is required');
  }
  for (const st of spec.sourcetypes) {
    if (!st.sourcetype || !String(st.sourcetype).trim()) {
      throw new Error('each sourcetype entry needs a non-empty sourcetype');
    }
  }
  const files: ScaffoldFile[] = [
    { path: 'tests/pytest.ini', content: buildPytestIni() },
    { path: 'tests/requirements.txt', content: buildRequirements() },
    { path: `tests/test_${safeName(spec.addonName)}.py`, content: buildTestModule(spec.addonName) },
    { path: 'tests/data/pytest-splunk-addon-data.conf', content: buildDataConf(spec) },
    { path: 'tests/README.md', content: buildReadme(spec) },
    ...buildSampleFiles(spec),
  ];
  return { files };
}
