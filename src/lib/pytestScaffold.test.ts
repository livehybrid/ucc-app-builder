import { describe, it, expect } from 'vitest';
import {
  buildPytestScaffold,
  buildDataConf,
  buildSampleFiles,
  sampleFileName,
} from './pytestScaffold';

describe('sampleFileName', () => {
  it('makes a filesystem-safe .sample name from a sourcetype', () => {
    expect(sampleFileName('weatherapi:observation')).toBe('weatherapi_observation.sample');
    expect(sampleFileName('My Source/Type!')).toBe('my_source_type.sample');
  });
});

describe('buildDataConf', () => {
  it('emits one stanza per sourcetype with the required pytest-splunk-addon keys', () => {
    const conf = buildDataConf({
      addonName: 'ta_weather',
      sourcetypes: [
        { sourcetype: 'weatherapi:obs', cimDataModels: ['Weather'], sampleEvents: ['a', 'b', 'c'] },
      ],
    });
    expect(conf).toMatch(/^\[weatherapi_obs\.sample\]/m);
    expect(conf).toMatch(/sourcetype = weatherapi:obs/);
    expect(conf).toMatch(/source = weatherapi:obs/);
    expect(conf).toMatch(/sourcetype_to_search = weatherapi:obs/);
    expect(conf).toMatch(/input_type = modinput/);
    expect(conf).toMatch(/timestamp_type = plugin/);
    // count reflects the number of supplied sample events.
    expect(conf).toMatch(/count = 3/);
    expect(conf).toMatch(/expected_event_count = 3/);
  });

  it('defaults source/index/input_type and count=1 when not provided', () => {
    const conf = buildDataConf({
      addonName: 'ta_x',
      sourcetypes: [{ sourcetype: 'x:y', index: 'security', inputType: 'file_monitor' }],
    });
    expect(conf).toMatch(/index = security/);
    expect(conf).toMatch(/input_type = file_monitor/);
    expect(conf).toMatch(/count = 1/);
  });
});

describe('buildSampleFiles', () => {
  it('seeds the .sample file verbatim from captured events (one per line)', () => {
    const [f] = buildSampleFiles({
      addonName: 'ta_x',
      sourcetypes: [{ sourcetype: 'x:y', sampleEvents: ['{"a":1}', '{"b":2}'] }],
    });
    expect(f.path).toBe('tests/data/samples/x_y.sample');
    expect(f.content).toBe('{"a":1}\n{"b":2}\n');
  });

  it('writes a placeholder when no events are supplied', () => {
    const [f] = buildSampleFiles({ addonName: 'ta_x', sourcetypes: [{ sourcetype: 'x:y' }] });
    expect(f.content).toMatch(/replace_me/);
  });

  it('flattens multi-line events to one line each (sample = one event per line)', () => {
    const [f] = buildSampleFiles({
      addonName: 'ta_x',
      sourcetypes: [{ sourcetype: 'x:y', sampleEvents: ['line1\nline2'] }],
    });
    expect(f.content).toBe('line1 line2\n');
  });
});

describe('buildPytestScaffold', () => {
  const scaffold = buildPytestScaffold({
    addonName: 'ta_weather',
    sourcetypes: [{ sourcetype: 'weatherapi:obs', sampleEvents: ['{"temp":21}'] }],
  });
  const byPath = Object.fromEntries(scaffold.files.map((f) => [f.path, f.content]));

  it('produces the full pytest-splunk-addon file set', () => {
    expect(Object.keys(byPath).sort()).toEqual(
      [
        'tests/data/pytest-splunk-addon-data.conf',
        'tests/data/samples/weatherapi_obs.sample',
        'tests/pytest.ini',
        'tests/README.md',
        'tests/requirements.txt',
        'tests/test_ta_weather.py',
      ].sort()
    );
  });

  it('the test module subclasses Basic to trigger the standard suite', () => {
    const mod = byPath['tests/test_ta_weather.py'];
    expect(mod).toMatch(/from pytest_splunk_addon\.standard_lib\.addon_basic import Basic/);
    expect(mod).toMatch(/class Test_TaWeather\(Basic\):/);
    expect(mod).toMatch(/def empty_method\(self\):/);
  });

  it('requirements pin pytest-splunk-addon', () => {
    expect(byPath['tests/requirements.txt']).toMatch(/pytest-splunk-addon>=5\.0,<6\.0/);
  });

  it('README documents the emulate -> model -> prove loop and the run command', () => {
    const readme = byPath['tests/README.md'];
    expect(readme).toMatch(/Test Input/);
    expect(readme).toMatch(/--splunk-data-generator=tests\/data/);
    expect(readme).toMatch(/weatherapi:obs/);
  });

  it('rejects an empty sourcetype list', () => {
    expect(() => buildPytestScaffold({ addonName: 'ta_x', sourcetypes: [] })).toThrow(
      /at least one sourcetype/
    );
  });

  it('rejects a missing addonName', () => {
    expect(() =>
      buildPytestScaffold({ addonName: '', sourcetypes: [{ sourcetype: 'x:y' }] })
    ).toThrow(/addonName is required/);
  });
});
