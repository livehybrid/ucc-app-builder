import { describe, it, expect } from 'vitest';
import { ConfSpecIndex, parseConfSpec } from './confSpec';

const INPUTS_SPEC = `# inputs.conf.spec - sample
# Preamble comment.

[default]
* The default stanza.
host = <string>
* The default host value.
* Defaults to $decideOnStartup

[script://<cmd>]
* Run a script on an interval.
interval = <number>|<cron>
* Poll frequency in seconds, or a cron expression.
* Default: 60
index = <string>
* Target index.
`;

describe('parseConfSpec', () => {
  it('parses stanzas with docs and settings', () => {
    const spec = parseConfSpec(INPUTS_SPEC);
    expect(spec.preamble).toContain('Preamble comment.');
    expect(spec.stanzas).toHaveLength(2);

    const [def, script] = spec.stanzas;
    expect(def.name).toBe('default');
    expect(def.doc).toBe('The default stanza.');
    expect(def.settings).toHaveLength(1);
    expect(def.settings[0]).toMatchObject({
      name: 'host',
      rhs: '<string>',
      default: '$decideOnStartup',
    });

    expect(script.name).toBe('script://<cmd>');
    expect(script.doc).toBe('Run a script on an interval.');
    expect(script.settings.map((s) => s.name)).toEqual(['interval', 'index']);
    expect(script.settings[0].default).toBe('60');
  });
});

describe('ConfSpecIndex', () => {
  it('registers and looks up stanzas', () => {
    const idx = new ConfSpecIndex();
    idx.register('inputs.conf.spec', INPUTS_SPEC);
    expect(idx.listConfs()).toEqual(['inputs.conf']);
    expect(idx.listStanzas('inputs.conf')).toEqual(['default', 'script://<cmd>']);
  });

  it('matches stanza by exact name', () => {
    const idx = new ConfSpecIndex();
    idx.register('inputs.conf.spec', INPUTS_SPEC);
    expect(idx.getStanza('inputs.conf', 'default')!.name).toBe('default');
  });

  it('falls back to prefix match', () => {
    const idx = new ConfSpecIndex();
    idx.register('inputs.conf.spec', INPUTS_SPEC);
    expect(idx.getStanza('inputs.conf', 'script')!.name).toBe('script://<cmd>');
  });

  it('returns null for unknown conf', () => {
    const idx = new ConfSpecIndex();
    expect(idx.getStanza('unknown.conf', 'any')).toBeNull();
  });

  it('looks up a specific setting', () => {
    const idx = new ConfSpecIndex();
    idx.register('inputs.conf.spec', INPUTS_SPEC);
    const setting = idx.getSetting('inputs.conf', 'script', 'interval');
    expect(setting?.rhs).toBe('<number>|<cron>');
    expect(setting?.default).toBe('60');
  });
});
