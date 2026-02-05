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

    expect(result.stanzas[0].description).toBe('This is a stanza description.');
    const param = result.stanzas[0].params.get('key');
    expect(param?.description).toBe('This is a key description.\nIt has multiple lines.');
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
    expect(result.stanzas[0].description).toBeUndefined();
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
});
