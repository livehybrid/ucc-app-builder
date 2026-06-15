import { describe, it, expect } from 'vitest';
import { selectToolCallingModels } from './openrouterModels.js';

const model = (id: string, opts: Partial<Record<string, unknown>> = {}) => ({
  id,
  name: opts.name ?? id,
  context_length: opts.context_length ?? 128000,
  supported_parameters: opts.supported_parameters ?? ['tools', 'temperature'],
  ...opts,
});

describe('selectToolCallingModels', () => {
  it('keeps only tool-calling models with a workable context window', () => {
    const out = selectToolCallingModels([
      model('anthropic/claude-sonnet-4'),
      model('some/no-tools', { supported_parameters: ['temperature'] }),
      model('some/tiny-context', { context_length: 8000 }),
    ]);
    expect(out.map((m) => m.id)).toEqual(['anthropic/claude-sonnet-4']);
  });

  it('orders preferred providers first and labels with provider + context', () => {
    const out = selectToolCallingModels([
      model('zz-unknown/some-model'),
      model('openai/gpt-4o'),
      model('moonshotai/kimi-k2'),
    ]);
    expect(out[0].provider).toBe('moonshotai');
    expect(out[1].provider).toBe('openai');
    expect(out[2].provider).toBe('zz-unknown');
    expect(out[0].contextLength).toBe(128000);
  });

  it('caps the list and drops malformed entries', () => {
    const many = Array.from({ length: 80 }, (_, i) => model(`prov/m${i}`));
    expect(selectToolCallingModels(many)).toHaveLength(60);
    expect(
      selectToolCallingModels([{ supported_parameters: ['tools'], context_length: 99000 }])
    ).toHaveLength(0);
  });

  it('extracts per-token pricing when present and omits it for free models', () => {
    const [paid] = selectToolCallingModels([
      model('anthropic/claude', { pricing: { prompt: '0.000003', completion: '0.000015' } }),
    ]);
    expect(paid.pricing).toEqual({ prompt: 0.000003, completion: 0.000015 });

    const [free] = selectToolCallingModels([
      model('free/model', { pricing: { prompt: '0', completion: '0' } }),
    ]);
    expect(free.pricing).toBeUndefined();
  });
});
