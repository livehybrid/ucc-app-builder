import { describe, it, expect } from 'vitest';
import {
  buildDashboardDefinition,
  buildDashboardViewXml,
  viewFileName,
  buildSavedSearchStanza,
} from './splunkArtifacts';

describe('buildDashboardDefinition', () => {
  const spec = {
    title: '4xx Overview',
    description: 'web errors',
    panels: [
      { title: 'Errors over time', spl: 'index=web status>=400 | timechart count', viz: 'line' as const },
      { title: 'By endpoint', spl: 'index=web status>=400 | top uri', viz: 'bar' as const, earliest: '-7d' },
    ],
  };

  it('emits Studio dataSources + visualizations + grid layout for each panel', () => {
    const d = buildDashboardDefinition(spec);
    const ds = d.dataSources as Record<string, { type: string; options: { query: string } }>;
    const viz = d.visualizations as Record<string, { type: string; dataSources: { primary: string } }>;
    expect(Object.keys(ds)).toEqual(['ds_0', 'ds_1']);
    expect(ds.ds_0.type).toBe('ds.search');
    expect(ds.ds_0.options.query).toMatch(/timechart count/);
    expect(viz.viz_0.type).toBe('splunk.line');
    expect(viz.viz_1.type).toBe('splunk.bar');
    expect(viz.viz_0.dataSources.primary).toBe('ds_0');
    const layout = d.layout as { type: string; structure: Array<{ item: string; position: { x: number; w: number } }> };
    expect(layout.type).toBe('grid');
    expect(layout.structure).toHaveLength(2);
    // 2-column grid: panel 1 at x=0, panel 2 at x=600.
    expect(layout.structure[0].position.x).toBe(0);
    expect(layout.structure[1].position.x).toBe(600);
  });

  it('honours a per-panel time range', () => {
    const d = buildDashboardDefinition(spec);
    const ds = d.dataSources as Record<string, { options: { queryParameters: { earliest: string } } }>;
    expect(ds.ds_1.options.queryParameters.earliest).toBe('-7d');
  });

  it('falls back to splunk.table for an unknown viz', () => {
    const d = buildDashboardDefinition({
      title: 'x',
      panels: [{ title: 'p', spl: 'index=_internal', viz: 'weird' as never }],
    });
    const viz = d.visualizations as Record<string, { type: string }>;
    expect(viz.viz_0.type).toBe('splunk.table');
  });
});

describe('buildDashboardViewXml', () => {
  it('wraps the definition in a version=2 dashboard with valid embedded JSON', () => {
    const xml = buildDashboardViewXml({ title: 'My & Board', panels: [{ title: 't', spl: 'index=x', viz: 'single' }] });
    expect(xml).toMatch(/<dashboard version="2" theme="dark">/);
    expect(xml).toMatch(/<label>My &amp; Board<\/label>/);
    const json = xml.slice(xml.indexOf('<![CDATA[') + 9, xml.indexOf(']]>'));
    expect(() => JSON.parse(json)).not.toThrow();
    expect(JSON.parse(json).visualizations.viz_0.type).toBe('splunk.singlevalue');
  });
});

describe('viewFileName', () => {
  it('produces a safe .xml file name', () => {
    expect(viewFileName('4xx Errors / Web!')).toBe('4xx_errors_web.xml');
    expect(viewFileName('')).toBe('dashboard.xml');
  });
});

describe('buildSavedSearchStanza', () => {
  it('builds a plain report', () => {
    const s = buildSavedSearchStanza({ name: 'Daily 4xx', search: 'index=web status>=400 | stats count' });
    expect(s).toMatch(/^\[Daily 4xx\]/);
    expect(s).toMatch(/search = index=web status>=400 \| stats count/);
    expect(s).toMatch(/dispatch.earliest_time = -24h@h/);
    expect(s).not.toMatch(/enableSched/);
  });

  it('schedules when cron is given', () => {
    const s = buildSavedSearchStanza({ name: 'r', search: 'x', cronSchedule: '0 * * * *' });
    expect(s).toMatch(/enableSched = 1/);
    expect(s).toMatch(/cron_schedule = 0 \* \* \* \*/);
  });

  it('builds an alert with threshold + severity + suppression', () => {
    const s = buildSavedSearchStanza({
      name: 'High errors',
      search: 'index=web status>=500 | stats count',
      alert: { condition: 'greater than', threshold: 100, severity: 4, suppressFields: 'host', suppressPeriod: '1h' },
    });
    expect(s).toMatch(/enableSched = 1/);
    expect(s).toMatch(/alert_threshold = 100/);
    expect(s).toMatch(/alert.severity = 4/);
    expect(s).toMatch(/alert.suppress = 1/);
    expect(s).toMatch(/alert.suppress.fields = host/);
  });

  it('flattens newlines in the SPL', () => {
    const s = buildSavedSearchStanza({ name: 'n', search: 'index=x\n| stats count' });
    expect(s).toMatch(/search = index=x \| stats count/);
  });
});
