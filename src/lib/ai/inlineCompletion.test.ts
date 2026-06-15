import { describe, it, expect } from 'vitest';
import { buildMessages, cleanCompletion } from './inlineCompletion';

describe('buildMessages (FIM prompt)', () => {
  it('wraps prefix/suffix and names the language', () => {
    const msgs = buildMessages({ prefix: '[input://x]\n', suffix: '\ndisabled = 0', language: 'splunk-conf' });
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toMatch(/\.conf/);
    expect(msgs[1].content).toContain('<PREFIX>[input://x]\n</PREFIX>');
    expect(msgs[1].content).toContain('<SUFFIX>\ndisabled = 0</SUFFIX>');
  });

  it('truncates a very long prefix to the tail and suffix to the head', () => {
    const prefix = 'A'.repeat(5000);
    const suffix = 'B'.repeat(5000);
    const msgs = buildMessages({ prefix, suffix, language: 'python' });
    const user = msgs[1].content;
    // prefix kept to <=2500, suffix to <=800
    expect((user.match(/A/g) || []).length).toBe(2500);
    expect((user.match(/B/g) || []).length).toBe(800);
  });
});

describe('cleanCompletion', () => {
  it('strips a wrapping code fence', () => {
    expect(cleanCompletion('```python\nprint(1)\n```', '')).toBe('print(1)');
  });

  it('drops an echoed prefix overlap', () => {
    // model echoed the last bit of the prefix before its continuation
    expect(cleanCompletion('index = main\nsourcetype = x', 'index = ')).toBe('main\nsourcetype = x');
  });

  it('removes a stray leading newline', () => {
    expect(cleanCompletion('\nfoo', 'bar')).toBe('foo');
  });

  it('returns plain text unchanged when there is nothing to clean', () => {
    expect(cleanCompletion('= 300', 'interval ')).toBe('= 300');
  });
});
