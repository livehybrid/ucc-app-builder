"""
Deterministic, LLM-free generators for the Splunk artifacts the builder emits - the
native-Python port of src/lib/splunkArtifacts.ts + src/lib/pytestScaffold.ts.

These back the generate_dashboard / generate_savedsearch / generate_tests tools (and the
SPA's /api/generate/* routes) entirely inside Splunk's python, so no Node sidecar is
needed. A caller passes a structured spec; we emit the exact, valid format (Dashboard
Studio v2 view XML, a savedsearches.conf stanza, or a pytest-splunk-addon scaffold).
"""
import json
import re

# ---------------------------------------------------------------------------------------
# Dashboard Studio
# ---------------------------------------------------------------------------------------

_VIZ_MAP = {
    'line': 'splunk.line',
    'area': 'splunk.area',
    'column': 'splunk.column',
    'bar': 'splunk.bar',
    'table': 'splunk.table',
    'single': 'splunk.singlevalue',
    'pie': 'splunk.pie',
    'scatter': 'splunk.scatter',
    'map': 'splunk.map',
}


def build_dashboard_definition(spec):
    """Build the Dashboard Studio JSON `definition` object from a structured spec."""
    data_sources = {}
    visualizations = {}
    structure = []

    COLS, W, H = 2, 600, 250
    panels = spec.get('panels') or []
    for i, p in enumerate(panels):
        ds_id = 'ds_%d' % i
        viz_id = 'viz_%d' % i
        title = p.get('title') or ('Panel %d' % (i + 1))
        data_sources[ds_id] = {
            'type': 'ds.search',
            'name': '%s - search' % title,
            'options': {
                'query': p.get('spl') or '',
                'queryParameters': {
                    'earliest': p.get('earliest') or '-24h@h',
                    'latest': p.get('latest') or 'now',
                },
            },
        }
        visualizations[viz_id] = {
            'type': _VIZ_MAP.get(p.get('viz'), 'splunk.table'),
            'title': title,
            'dataSources': {'primary': ds_id},
            'options': {},
        }
        col = i % COLS
        row = i // COLS
        structure.append({
            'item': viz_id,
            'type': 'block',
            'position': {'x': col * W, 'y': row * H, 'w': W, 'h': H},
        })

    height = max(H, ((len(panels) + COLS - 1) // COLS) * H)
    return {
        'title': spec.get('title') or '',
        'description': spec.get('description') or '',
        'dataSources': data_sources,
        'visualizations': visualizations,
        'defaults': {
            'dataSources': {
                'ds.search': {'options': {'queryParameters': {'earliest': '-24h@h', 'latest': 'now'}}},
            },
        },
        'inputs': {},
        'layout': {
            'type': 'grid',
            'options': {'width': COLS * W, 'height': height},
            'structure': structure,
            'globalInputs': [],
        },
    }


def _xml_escape(s):
    return (str(s or '')
            .replace('&', '&amp;')
            .replace('<', '&lt;')
            .replace('>', '&gt;'))


def build_dashboard_view_xml(spec):
    """Build the data/ui/views/<name>.xml Dashboard Studio (version 2) view."""
    definition = json.dumps(build_dashboard_definition(spec), indent=2)
    theme = 'light' if spec.get('theme') == 'light' else 'dark'
    return (
        '<dashboard version="2" theme="%s">\n'
        '  <label>%s</label>\n'
        '  <description>%s</description>\n'
        '  <definition><![CDATA[\n'
        '%s\n'
        ']]></definition>\n'
        '  <meta type="hiddenElements"><![CDATA[\n'
        '{\n'
        '  "hideEdit": false,\n'
        '  "hideOpenInSearch": false,\n'
        '  "hideExport": false\n'
        '}\n'
        ']]></meta>\n'
        '</dashboard>\n'
    ) % (theme, _xml_escape(spec.get('title')), _xml_escape(spec.get('description') or ''), definition)


def view_file_name(title):
    """Snake/kebab-safe view file name from a title."""
    base = re.sub(r'^_+|_+$', '', re.sub(r'[^a-z0-9]+', '_', (title or 'dashboard').lower())) or 'dashboard'
    return '%s.xml' % base


# ---------------------------------------------------------------------------------------
# savedsearches.conf
# ---------------------------------------------------------------------------------------

def _conf_escape(v):
    return re.sub(r'\r?\n', ' ', str(v if v is not None else '')).strip()


def build_savedsearch_stanza(spec):
    """Build a single savedsearches.conf stanza (report, scheduled report, or alert)."""
    lines = ['[%s]' % spec.get('name')]
    if spec.get('description'):
        lines.append('description = %s' % _conf_escape(spec.get('description')))
    lines.append('search = %s' % _conf_escape(spec.get('search')))
    lines.append('dispatch.earliest_time = %s' % (spec.get('earliest') or '-24h@h'))
    lines.append('dispatch.latest_time = %s' % (spec.get('latest') or 'now'))

    alert = spec.get('alert')
    scheduled = bool(spec.get('cronSchedule')) or bool(alert)
    if scheduled:
        lines.append('enableSched = 1')
        lines.append('cron_schedule = %s' % (spec.get('cronSchedule') or '*/15 * * * *'))

    if alert:
        threshold = alert.get('threshold')
        threshold = 0 if threshold is None else threshold
        condition = alert.get('condition') or 'greater than'
        if alert.get('conditionSearch'):
            lines.append('alert_type = custom')
            lines.append('alert_condition = %s' % _conf_escape(alert.get('conditionSearch')))
        else:
            lines.append('alert_type = %s' % condition)
            lines.append('alert_comparator = %s' % condition)
            lines.append('alert_threshold = %s' % threshold)
            lines.append('counttype = number of events')
            lines.append('relation = %s' % condition)
            lines.append('quantity = %s' % threshold)
        lines.append('alert.track = 1')
        lines.append('alert.severity = %s' % (alert.get('severity') if alert.get('severity') is not None else 3))
        lines.append('alert.digest_mode = 1')
        if alert.get('suppressFields') or alert.get('suppressPeriod'):
            lines.append('alert.suppress = 1')
            if alert.get('suppressPeriod'):
                lines.append('alert.suppress.period = %s' % alert.get('suppressPeriod'))
            if alert.get('suppressFields'):
                lines.append('alert.suppress.fields = %s' % alert.get('suppressFields'))
    return '\n'.join(lines) + '\n'


# ---------------------------------------------------------------------------------------
# pytest-splunk-addon scaffold
# ---------------------------------------------------------------------------------------

def _safe_name(s):
    return re.sub(r'^_+|_+$', '', re.sub(r'[^a-z0-9]+', '_', str(s or '').lower())) or 'sample'


def sample_file_name(sourcetype):
    return '%s.sample' % _safe_name(sourcetype)


def _build_data_conf(spec):
    blocks = []
    for st in spec.get('sourcetypes') or []:
        file = sample_file_name(st.get('sourcetype'))
        samples = st.get('sampleEvents') or []
        count = len(samples) if samples else 1
        blocks.append('\n'.join([
            '[%s]' % file,
            'sourcetype = %s' % st.get('sourcetype'),
            'source = %s' % (st.get('source') or st.get('sourcetype')),
            'sourcetype_to_search = %s' % st.get('sourcetype'),
            'host_type = plugin',
            'input_type = %s' % (st.get('inputType') or 'modinput'),
            'index = %s' % (st.get('index') or 'main'),
            'timestamp_type = plugin',
            'count = %d' % count,
            'expected_event_count = %d' % count,
        ]))
    return '\n\n'.join(blocks) + '\n'


_PLACEHOLDER_EVENT = (
    '{"replace_me": "Paste a real sample event here - one event per line. '
    'Tip: use Test Input to capture real events, then drop them in."}'
)


def _build_sample_files(spec):
    out = []
    for st in spec.get('sourcetypes') or []:
        samples = st.get('sampleEvents') or []
        lines = [re.sub(r'\r?\n', ' ', str(e)) for e in samples] if samples else [_PLACEHOLDER_EVENT]
        out.append({
            'path': 'tests/data/samples/%s' % sample_file_name(st.get('sourcetype')),
            'content': '\n'.join(lines) + '\n',
        })
    return out


def _build_test_module(addon_name):
    parts = _safe_name(addon_name).split('_')
    cls = 'Test_' + (''.join(p[:1].upper() + p[1:] for p in parts if p) or 'Addon')
    return (
        '"""\n'
        'pytest-splunk-addon entry point for %s.\n'
        '\n'
        "Subclassing Basic registers the framework's standard tests - sourcetype / source / index\n"
        'assignment, field extractions (props.conf / transforms.conf) and CIM data-model compliance -\n'
        'generated from the sample events under tests/data/. You do not write the assertions; the\n'
        'plugin does, driven by the .sample files and your knowledge objects.\n'
        '\n'
        'Docs: https://splunk.github.io/pytest-splunk-addon/\n'
        '"""\n'
        'from pytest_splunk_addon.standard_lib.addon_basic import Basic\n'
        '\n'
        '\n'
        'class %s(Basic):\n'
        '    def empty_method(self):\n'
        '        pass\n'
    ) % (addon_name, cls)


def _build_pytest_ini():
    return (
        '[pytest]\n'
        '# Connection + app/data-generator paths are passed on the CLI (see README.md) so this file\n'
        '# stays portable across environments. -ra surfaces a summary of skips/xfails.\n'
        'addopts = -ra -v\n'
    )


def _build_requirements():
    return (
        "# Validation harness for this add-on's knowledge objects (props/transforms/CIM).\n"
        '# Pinned to the 5.x line; see https://splunk.github.io/pytest-splunk-addon/ for the matrix.\n'
        'pytest-splunk-addon>=5.0,<6.0\n'
        'pytest>=7.0\n'
    )


def _build_readme(spec):
    sts = []
    for st in spec.get('sourcetypes') or []:
        cims = st.get('cimDataModels') or []
        cim = (' - CIM: %s' % ', '.join(cims)) if cims else ''
        sts.append('- `%s` (samples: `tests/data/samples/%s`)%s'
                   % (st.get('sourcetype'), sample_file_name(st.get('sourcetype')), cim))
    addon = spec.get('addonName')
    return (
        '# Tests - %s\n\n'
        "Automated validation of this add-on's knowledge objects with\n"
        '[pytest-splunk-addon](https://splunk.github.io/pytest-splunk-addon/): it ingests the sample\n'
        'events below into a real Splunk and asserts sourcetype/source/index assignment, field\n'
        'extractions (props.conf / transforms.conf) and CIM data-model compliance - no hand-written\n'
        'test code.\n\n'
        '## The data loop\n\n'
        '1. **See the data** - use **Test Input** (the input emulator) to run an input and capture\n'
        '   the real events it produces.\n'
        '2. **Model it** - author `props.conf` / `transforms.conf` (field extractions, sourcetype\n'
        '   assignment, CIM aliases/eval).\n'
        '3. **Prove it** - drop the captured events into `tests/data/samples/*.sample` and run the\n'
        '   suite below. Iterate until green.\n\n'
        '## Sourcetypes under test\n\n'
        '%s\n\n'
        '## Running\n\n'
        '```bash\n'
        'pip install -r tests/requirements.txt\n\n'
        '# Build the add-on first (ucc-gen build / Download Source), then point --splunk-app at it.\n'
        'pytest tests/ \\\n'
        '  --splunk-app=/path/to/built/%s \\\n'
        '  --splunk-data-generator=tests/data \\\n'
        '  --splunk-type=external \\\n'
        '  --splunk-host=<host> --splunk-port=8089 \\\n'
        '  --splunk-user=admin --splunk-password=<pw>\n'
        '```\n\n'
        'To validate CIM compliance only, add `-m "splunk_searchtime_cim"`; for field extractions,\n'
        '`-m "splunk_searchtime_fields"`. See the plugin docs for the full marker list.\n'
    ) % (addon, '\n'.join(sts), addon)


def build_pytest_scaffold(spec):
    """Build the full pytest-splunk-addon scaffold file set for an add-on.
    Returns {'files': [{'path','content'}, ...]}. Raises ValueError on a bad spec."""
    addon = spec.get('addonName')
    if not addon or not str(addon).strip():
        raise ValueError('addonName is required')
    sourcetypes = spec.get('sourcetypes')
    if not isinstance(sourcetypes, list) or len(sourcetypes) == 0:
        raise ValueError('at least one sourcetype is required')
    for st in sourcetypes:
        if not st.get('sourcetype') or not str(st.get('sourcetype')).strip():
            raise ValueError('each sourcetype entry needs a non-empty sourcetype')
    files = [
        {'path': 'tests/pytest.ini', 'content': _build_pytest_ini()},
        {'path': 'tests/requirements.txt', 'content': _build_requirements()},
        {'path': 'tests/test_%s.py' % _safe_name(addon), 'content': _build_test_module(addon)},
        {'path': 'tests/data/pytest-splunk-addon-data.conf', 'content': _build_data_conf(spec)},
        {'path': 'tests/README.md', 'content': _build_readme(spec)},
    ]
    files.extend(_build_sample_files(spec))
    return {'files': files}
