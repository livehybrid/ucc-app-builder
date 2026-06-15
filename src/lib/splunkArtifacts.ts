/**
 * Deterministic generators for the two Splunk artifacts our MCP tools expose:
 *   - Dashboard Studio dashboards (version="2" view XML with a JSON definition)
 *   - savedsearches.conf stanzas (reports + scheduled alerts)
 *
 * These are the reliable core behind `generate_dashboard` / `generate_savedsearch`: a
 * calling agent (the Splunk AI Assistant, Claude Desktop, or our own chat) decides WHAT
 * panels/searches it wants and passes a structured spec; we emit the exact, valid format
 * (which models routinely get wrong by hand). No LLM in the generator → fast, free, correct.
 */

// ---------------------------------------------------------------------------------------
// Dashboard Studio
// ---------------------------------------------------------------------------------------

export type VizType =
  | 'line'
  | 'area'
  | 'column'
  | 'bar'
  | 'table'
  | 'single'
  | 'pie'
  | 'scatter'
  | 'map';

export interface DashboardPanel {
  title: string;
  /** SPL search powering the panel. */
  spl: string;
  viz: VizType;
  earliest?: string;
  latest?: string;
}

export interface DashboardSpec {
  title: string;
  description?: string;
  panels: DashboardPanel[];
  theme?: 'light' | 'dark';
}

const VIZ_MAP: Record<VizType, string> = {
  line: 'splunk.line',
  area: 'splunk.area',
  column: 'splunk.column',
  bar: 'splunk.bar',
  table: 'splunk.table',
  single: 'splunk.singlevalue',
  pie: 'splunk.pie',
  scatter: 'splunk.scatter',
  map: 'splunk.map',
};

/** Build the Dashboard Studio JSON `definition` object from a structured spec. */
export function buildDashboardDefinition(spec: DashboardSpec): Record<string, unknown> {
  const dataSources: Record<string, unknown> = {};
  const visualizations: Record<string, unknown> = {};
  const structure: Array<Record<string, unknown>> = [];

  // 2-column grid on a 1200-wide canvas; each panel 600x250, stacking down.
  const COLS = 2;
  const W = 600;
  const H = 250;
  spec.panels.forEach((p, i) => {
    const dsId = `ds_${i}`;
    const vizId = `viz_${i}`;
    dataSources[dsId] = {
      type: 'ds.search',
      name: `${p.title || `Panel ${i + 1}`} — search`,
      options: {
        query: p.spl,
        queryParameters: { earliest: p.earliest || '-24h@h', latest: p.latest || 'now' },
      },
    };
    visualizations[vizId] = {
      type: VIZ_MAP[p.viz] || 'splunk.table',
      title: p.title || `Panel ${i + 1}`,
      dataSources: { primary: dsId },
      options: {},
    };
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    structure.push({
      item: vizId,
      type: 'block',
      position: { x: col * W, y: row * H, w: W, h: H },
    });
  });

  return {
    title: spec.title,
    description: spec.description || '',
    dataSources,
    visualizations,
    defaults: {
      dataSources: {
        'ds.search': { options: { queryParameters: { earliest: '-24h@h', latest: 'now' } } },
      },
    },
    inputs: {},
    layout: {
      type: 'grid',
      options: { width: COLS * W, height: Math.max(H, Math.ceil(spec.panels.length / COLS) * H) },
      structure,
      globalInputs: [],
    },
  };
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Build the `data/ui/views/<name>.xml` Dashboard Studio (version 2) view. */
export function buildDashboardViewXml(spec: DashboardSpec): string {
  const def = JSON.stringify(buildDashboardDefinition(spec), null, 2);
  const theme = spec.theme === 'light' ? 'light' : 'dark';
  return `<dashboard version="2" theme="${theme}">
  <label>${xmlEscape(spec.title)}</label>
  <description>${xmlEscape(spec.description || '')}</description>
  <definition><![CDATA[
${def}
]]></definition>
  <meta type="hiddenElements"><![CDATA[
{
  "hideEdit": false,
  "hideOpenInSearch": false,
  "hideExport": false
}
]]></meta>
</dashboard>
`;
}

/** Snake/kebab-safe view file name from a title. */
export function viewFileName(title: string): string {
  const base =
    (title || 'dashboard')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'dashboard';
  return `${base}.xml`;
}

// ---------------------------------------------------------------------------------------
// savedsearches.conf
// ---------------------------------------------------------------------------------------

export interface SavedSearchSpec {
  name: string;
  search: string;
  description?: string;
  earliest?: string;
  latest?: string;
  /** When set, the search is scheduled with this cron. */
  cronSchedule?: string;
  /** Alerting (implies a schedule). */
  alert?: {
    /** number of results threshold, e.g. "greater than 0" */
    condition?: 'greater than' | 'less than' | 'equal to' | 'not equal to' | 'rises by' | 'drops by';
    threshold?: number;
    /** custom alert condition SPL (overrides condition/threshold when set) */
    conditionSearch?: string;
    severity?: 1 | 2 | 3 | 4 | 5 | 6;
    suppressFields?: string;
    suppressPeriod?: string;
  };
}

function confEscape(v: string): string {
  // savedsearches.conf is multiline-tolerant via line continuations; keep it on one logical
  // line by escaping newlines for safety in the SPL value.
  return String(v).replace(/\r?\n/g, ' ').trim();
}

/** Build a single savedsearches.conf stanza (report, scheduled report, or alert). */
export function buildSavedSearchStanza(spec: SavedSearchSpec): string {
  const lines: string[] = [`[${spec.name}]`];
  if (spec.description) lines.push(`description = ${confEscape(spec.description)}`);
  lines.push(`search = ${confEscape(spec.search)}`);
  lines.push(`dispatch.earliest_time = ${spec.earliest || '-24h@h'}`);
  lines.push(`dispatch.latest_time = ${spec.latest || 'now'}`);

  const scheduled = !!spec.cronSchedule || !!spec.alert;
  if (scheduled) {
    lines.push('enableSched = 1');
    lines.push(`cron_schedule = ${spec.cronSchedule || '*/15 * * * *'}`);
  }

  if (spec.alert) {
    const a = spec.alert;
    if (a.conditionSearch) {
      lines.push('alert_type = custom');
      lines.push(`alert_condition = ${confEscape(a.conditionSearch)}`);
    } else {
      lines.push(`alert_type = ${a.condition || 'greater than'}`);
      lines.push(`alert_comparator = ${a.condition || 'greater than'}`);
      lines.push(`alert_threshold = ${a.threshold ?? 0}`);
      lines.push('counttype = number of events');
      lines.push(`relation = ${a.condition || 'greater than'}`);
      lines.push(`quantity = ${a.threshold ?? 0}`);
    }
    lines.push('alert.track = 1');
    lines.push(`alert.severity = ${a.severity ?? 3}`);
    lines.push('alert.digest_mode = 1');
    if (a.suppressFields || a.suppressPeriod) {
      lines.push('alert.suppress = 1');
      if (a.suppressPeriod) lines.push(`alert.suppress.period = ${a.suppressPeriod}`);
      if (a.suppressFields) lines.push(`alert.suppress.fields = ${a.suppressFields}`);
    }
  }
  return lines.join('\n') + '\n';
}
