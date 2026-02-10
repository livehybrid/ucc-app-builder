import { describe, it, expect } from 'vitest';
import { SpecParser } from './specParser';

describe('SpecParser', () => {
  const parser = new SpecParser();

  it('should parse simple exact stanzas', () => {
    const content = `
[default]
key = value
    `;
    const result = parser.parse('test.conf.spec', content);

    expect(result.stanzas).toHaveLength(1);
    expect(result.stanzas[0].name).toBe('default');
    expect(result.stanzas[0].matchType).toBe('exact');
    expect(result.stanzas[0].params.has('key')).toBe(true);
  });

  it('should parse regex/wildcard stanzas with <var>', () => {
    const content = `
[monitor://<path>]
disabled = boolean
    `;
    const result = parser.parse('inputs.conf.spec', content);

    expect(result.stanzas).toHaveLength(1);
    expect(result.stanzas[0].name).toBe('monitor://<path>');
    expect(result.stanzas[0].matchType).toBe('regex');
    expect(result.stanzas[0].pattern).toBeDefined();
    expect(result.stanzas[0].pattern?.test('monitor:///var/log/syslog')).toBe(true);
  });

  it('should handle ellipsis (...) in stanza names as regex', () => {
    const content = `
[my_stanza://...]
key = value
    `;
    const result = parser.parse('test.conf.spec', content);
    expect(result.stanzas[0].matchType).toBe('regex');
    expect(result.stanzas[0].pattern?.test('my_stanza://anything/here')).toBe(true);
  });

  it('should escape special regex characters in stanza names', () => {
    const content = `
[script://$PYTHON_HOME/etc/apps/search/bin/test.py]
disabled = boolean
    `;
    const result = parser.parse('inputs.conf.spec', content);
    // Should match exactly despite the $ and . characters
    expect(result.stanzas[0].name).toBe('script://$PYTHON_HOME/etc/apps/search/bin/test.py');
  });

  it('should parse documentation comments for both stanzas and params', () => {
    const content = `
[stanza]
* This is a stanza description.
key = value
* This is a key description.
* It has multiple lines.
    `;
    const result = parser.parse('test.conf.spec', content);

    expect(result.stanzas[0].description).toContain('This is a stanza description.');
    const param = result.stanzas[0].params.get('key');
    expect(param?.description).toContain('This is a key description.');
    expect(param?.description).toContain('It has multiple lines.');
  });

  it('should handle parameter values containing equals signs', () => {
    const content = `
[stanza]
complex_key = attr1=val1,attr2=val2
    `;
    const result = parser.parse('test.conf.spec', content);
    const param = result.stanzas[0].params.get('complex_key');
    expect(param?.type).toBe('attr1=val1,attr2=val2');
  });

  it('should ignore standard comments and empty lines', () => {
    const content = `
# This is a comment
[stanza]

# Another comment
key = value
    `;
    const result = parser.parse('test.conf.spec', content);
    expect(result.stanzas).toHaveLength(1);
    expect(result.stanzas[0].params.size).toBe(1);
  });

  it('should handle multiple stanzas with multiple parameters', () => {
    const content = `
[stanza1]
key1 = val1
key2 = val2

[stanza2]
key3 = val3
    `;
    const result = parser.parse('test.conf.spec', content);
    expect(result.stanzas).toHaveLength(2);
    expect(result.stanzas[0].params.size).toBe(2);
    expect(result.stanzas[1].params.size).toBe(1);
  });

  // Tests for real Splunk spec file format compatibility
  describe('real Splunk spec format', () => {
    it('should parse dynamic stanza names like [<spec>]', () => {
      const content = `
[<spec>]
* This stanza enables properties for a given sourcetype.
SHOULD_LINEMERGE = <boolean>
* Whether or not to combine several lines into a single event.
      `;
      const result = parser.parse('props.conf.spec', content);
      expect(result.stanzas).toHaveLength(1);
      expect(result.stanzas[0].matchType).toBe('regex');
      expect(result.stanzas[0].pattern?.test('syslog')).toBe(true);
      expect(result.stanzas[0].pattern?.test('access_combined')).toBe(true);
      expect(result.stanzas[0].params.has('SHOULD_LINEMERGE')).toBe(true);
    });

    it('should parse dynamic param names like TRANSFORMS-<class>', () => {
      const content = `
[<spec>]
TRANSFORMS-<class> = <transform_stanza_name>, <transform_stanza_name2>,...
* Used for creating indexed fields.
REPORT-<class> = <transform_stanza_name>,...
* Used for creating search-time field extractions.
EXTRACT-<name> = <regex>
* Inline field extraction using named capture groups.
      `;
      const result = parser.parse('props.conf.spec', content);
      expect(result.stanzas[0].params.has('TRANSFORMS-<class>')).toBe(true);
      expect(result.stanzas[0].params.has('REPORT-<class>')).toBe(true);
      expect(result.stanzas[0].params.has('EXTRACT-<name>')).toBe(true);
    });

    it('should parse stanzas with source:: and host:: prefixes', () => {
      const content = `
[source::<source>]
* Settings applied to a specific source.
sourcetype = <string>

[host::<host>]
* Settings applied to events from a specific host.
SHOULD_LINEMERGE = <boolean>
      `;
      const result = parser.parse('props.conf.spec', content);
      expect(result.stanzas).toHaveLength(2);
      expect(result.stanzas[0].pattern?.test('source::/var/log/messages')).toBe(true);
      expect(result.stanzas[1].pattern?.test('host::webserver01')).toBe(true);
    });

    it('should extract default values from documentation', () => {
      const content = `
[<spec>]
TRUNCATE = <integer>
* The default maximum line length, in bytes.
* Default: 10000

SHOULD_LINEMERGE = <boolean>
* Whether or not to combine several lines of data.
* Default: true
      `;
      const result = parser.parse('props.conf.spec', content);
      const truncate = result.stanzas[0].params.get('TRUNCATE');
      expect(truncate?.defaultValue).toBe('10000');
      const linemerge = result.stanzas[0].params.get('SHOULD_LINEMERGE');
      expect(linemerge?.defaultValue).toBe('true');
    });

    it('should handle pipe-separated value types', () => {
      const content = `
[<name>]
KV_MODE = [none|auto|auto_escaped|multi|json|xml]
* Specifies the field/value extraction mode.
      `;
      const result = parser.parse('props.conf.spec', content);
      const param = result.stanzas[0].params.get('KV_MODE');
      expect(param?.type).toBe('[none|auto|auto_escaped|multi|json|xml]');
    });

    it('should handle the ... pattern in Splunk stanza names', () => {
      const content = `
[source::....log]
* Match log files in any directory.
sourcetype = <string>
      `;
      const result = parser.parse('props.conf.spec', content);
      expect(result.stanzas[0].matchType).toBe('regex');
      expect(result.stanzas[0].pattern?.test('source::/var/log/app.log')).toBe(true);
    });

    it('should handle complex real-world stanza like [tcpout:<group>]', () => {
      const content = `
[tcpout:<group_name>]
server = <host>:<port>
* Comma-separated list of receiving hosts.
compressed = <boolean>
      `;
      const result = parser.parse('outputs.conf.spec', content);
      expect(result.stanzas[0].matchType).toBe('regex');
      expect(result.stanzas[0].pattern?.test('tcpout:my_indexers')).toBe(true);
      expect(result.stanzas[0].params.has('server')).toBe(true);
      expect(result.stanzas[0].params.has('compressed')).toBe(true);
    });
  });
});
