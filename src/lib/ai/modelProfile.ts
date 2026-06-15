/**
 * Model profile resolver.
 *
 * Lets self-hosters switch the agent between a single-model default (Kimi K2.6)
 * and multi-model routing (Anthropic, OpenAI, local Ollama) with one env var.
 *
 * The agent loop reads `resolveModelProfile()` at session start. Individual
 * roles may still be overridden via per-role env vars.
 */

export type AgentRole = 'planner' | 'executor' | 'router';

export type ModelProfileName =
  | 'kimi-single'
  | 'anthropic-multi'
  | 'openai-multi'
  | 'local-ollama'
  | 'custom';

export interface ModelProfile {
  name: ModelProfileName;
  models: Record<AgentRole, string>;
  notes?: string;
}

export const BUILTIN_PROFILES: Record<Exclude<ModelProfileName, 'custom'>, ModelProfile> = {
  'kimi-single': {
    name: 'kimi-single',
    models: {
      planner: 'moonshotai/kimi-k2.6',
      executor: 'moonshotai/kimi-k2.6',
      router: 'moonshotai/kimi-k2.6',
    },
    notes:
      'Default. SOTA open-source model (80.2% SWE-bench Verified). Single-model loop minimises complexity. ' +
      'Runs via OpenRouter; can be swapped for a local Ollama instance by picking `local-ollama`.',
  },
  'anthropic-multi': {
    name: 'anthropic-multi',
    models: {
      planner: 'anthropic/claude-opus-4.5',
      executor: 'anthropic/claude-sonnet-4.5',
      router: 'anthropic/claude-haiku-4.5',
    },
    notes: 'Quality-tier multi-model routing via OpenRouter.',
  },
  'openai-multi': {
    name: 'openai-multi',
    models: {
      planner: 'openai/gpt-5',
      executor: 'openai/gpt-5-codex',
      router: 'openai/gpt-5-mini',
    },
    notes: 'OpenAI-only routing.',
  },
  'local-ollama': {
    name: 'local-ollama',
    models: {
      planner: 'ollama:kimi-k2.6:Q2_K_XL',
      executor: 'ollama:kimi-k2.6:Q2_K_XL',
      router: 'ollama:kimi-k2.6:Q2_K_XL',
    },
    notes:
      'Fully self-hosted. Requires Ollama running locally and ~64 GB unified memory (Mac) or RTX 4090+ (Linux).',
  },
};

export function resolveModelProfile(env: NodeJS.ProcessEnv = process.env): ModelProfile {
  const name = (env.MODEL_PROFILE ?? 'kimi-single') as ModelProfileName;
  const base: ModelProfile =
    name in BUILTIN_PROFILES && name !== 'custom'
      ? BUILTIN_PROFILES[name as Exclude<ModelProfileName, 'custom'>]
      : { ...BUILTIN_PROFILES['kimi-single'], name: 'custom' };

  // Per-role overrides.
  const models = { ...base.models };
  if (env.MODEL_PLANNER) models.planner = env.MODEL_PLANNER;
  if (env.MODEL_EXECUTOR) models.executor = env.MODEL_EXECUTOR;
  if (env.MODEL_ROUTER) models.router = env.MODEL_ROUTER;

  return { ...base, models };
}

/** Single default model — convenience for the current AIChatPanel until we split roles. */
export function defaultModel(env: NodeJS.ProcessEnv = process.env): string {
  return resolveModelProfile(env).models.executor;
}
