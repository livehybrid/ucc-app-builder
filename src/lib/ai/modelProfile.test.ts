import { describe, it, expect } from 'vitest';
import { resolveModelProfile, defaultModel, BUILTIN_PROFILES } from './modelProfile';

describe('resolveModelProfile', () => {
  it('defaults to kimi-single', () => {
    const p = resolveModelProfile({});
    expect(p.name).toBe('kimi-single');
    expect(p.models.planner).toBe('moonshotai/kimi-k2.6');
    expect(p.models.executor).toBe('moonshotai/kimi-k2.6');
  });

  it('selects anthropic-multi', () => {
    const p = resolveModelProfile({ MODEL_PROFILE: 'anthropic-multi' });
    expect(p.models.planner).toContain('claude-opus');
    expect(p.models.executor).toContain('claude-sonnet');
  });

  it('per-role overrides win', () => {
    const p = resolveModelProfile({
      MODEL_PROFILE: 'kimi-single',
      MODEL_EXECUTOR: 'my/custom-model',
    });
    expect(p.models.executor).toBe('my/custom-model');
    expect(p.models.planner).toBe('moonshotai/kimi-k2.6');
  });

  it('unknown profile falls back to kimi + marks as custom', () => {
    const p = resolveModelProfile({ MODEL_PROFILE: 'does-not-exist' });
    expect(p.name).toBe('custom');
    expect(p.models.executor).toBe('moonshotai/kimi-k2.6');
  });

  it('defaultModel returns executor model', () => {
    expect(defaultModel({})).toBe('moonshotai/kimi-k2.6');
    expect(defaultModel({ MODEL_PROFILE: 'openai-multi' })).toBe('openai/gpt-5-codex');
  });

  it('builtin profiles are well-formed', () => {
    for (const [name, profile] of Object.entries(BUILTIN_PROFILES)) {
      expect(profile.models.planner).toBeTruthy();
      expect(profile.models.executor).toBeTruthy();
      expect(profile.models.router).toBeTruthy();
      expect(profile.name).toBe(name);
    }
  });
});
