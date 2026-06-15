/**
 * Live model catalog for the Settings model picker.
 *
 * Fetches OpenRouter's public model list, keeps only models that can actually
 * drive the agent (tool-calling support + a workable context window), and
 * caches the result in memory so the picker doesn't hammer the API.
 */

export type ModelInfo = {
  id: string;
  label: string;
  provider: string;
  contextLength: number;
  /** USD per token (OpenRouter reports per-token strings); omitted if unknown/free. */
  pricing?: { prompt: number; completion: number };
};

/** Providers we surface first — strongest tool-calling/coding models on top. */
const PROVIDER_ORDER = [
  'moonshotai',
  'anthropic',
  'openai',
  'google',
  'deepseek',
  'mistralai',
  'meta-llama',
  'qwen',
  'x-ai',
];

const MIN_CONTEXT = 32000;
const MAX_MODELS = 60;

type RawModel = Record<string, unknown>;

/**
 * Filter + shape OpenRouter's /api/v1/models payload into picker entries:
 * tool-calling capable, ≥32k context, preferred providers first, capped at 60.
 * Pure function so it is unit-testable without the network.
 */
export function selectToolCallingModels(raw: RawModel[]): ModelInfo[] {
  return raw
    .filter(
      (m) =>
        Array.isArray(m.supported_parameters) &&
        (m.supported_parameters as string[]).includes('tools')
    )
    .filter((m) => Number(m.context_length ?? 0) >= MIN_CONTEXT)
    .map((m) => {
      const id = String(m.id ?? '');
      const rawPricing = (m.pricing ?? {}) as { prompt?: string; completion?: string };
      const prompt = Number(rawPricing.prompt ?? 0);
      const completion = Number(rawPricing.completion ?? 0);
      const info: ModelInfo = {
        id,
        label: String(m.name ?? id),
        provider: id.split('/')[0] ?? '',
        contextLength: Number(m.context_length ?? 0),
      };
      // Only attach pricing when known and non-zero (free models report "0").
      if (prompt > 0 || completion > 0) info.pricing = { prompt, completion };
      return info;
    })
    .filter((m) => m.id)
    .sort((a, b) => {
      const pa = PROVIDER_ORDER.indexOf(a.provider);
      const pb = PROVIDER_ORDER.indexOf(b.provider);
      if (pa !== pb) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
      return a.label.localeCompare(b.label);
    })
    .slice(0, MAX_MODELS);
}

const CACHE_MS = 60 * 60 * 1000; // 1h — the catalog moves slowly
let cache: { at: number; models: ModelInfo[] } | null = null;

/** Fetch (or serve cached) tool-calling models. Returns [] on any failure. */
export async function getToolCallingModels(): Promise<{ models: ModelInfo[]; cached: boolean }> {
  if (cache && Date.now() - cache.at < CACHE_MS) {
    return { models: cache.models, cached: true };
  }
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models');
    if (!r.ok) throw new Error(`OpenRouter models endpoint returned ${r.status}`);
    const data = (await r.json()) as { data?: RawModel[] };
    const models = selectToolCallingModels(data.data ?? []);
    if (models.length) cache = { at: Date.now(), models };
    return { models, cached: false };
  } catch {
    // Network/API failure: the UI falls back to its static list.
    return { models: [], cached: false };
  }
}

/** Test hook: clear the in-memory cache. */
export function __resetModelsCache(): void {
  cache = null;
}
