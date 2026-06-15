/**
 * Deterministic natural-language spec -> UCC project parser.
 *
 * The loop panel lets a user describe an add-on in plain English. To keep the
 * demo (and the e2e test) hermetic and free, we map the spec to a ComponentsConfig
 * with a small, deterministic keyword parser — NO LLM call required. The agentic
 * self-correction still happens downstream in the AppInspect loop. (An LLM-assisted
 * spec parser can be layered on later via the AI chat; this is the reproducible path.)
 */
import { DEFAULT_COMPONENTS_CONFIG, type ComponentsConfig } from '../types/components';
import type { AppMetadata, BrandingConfig } from '../types/app';

export interface ParsedSpec {
  metadata: AppMetadata;
  branding: BrandingConfig;
  components: ComponentsConfig;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'addon'
  );
}

function titleFromSpec(spec: string): string {
  // First quoted phrase, else first few words.
  const quoted = spec.match(/["“']([^"”']{2,60})["”']/);
  if (quoted) return quoted[1].trim();
  const words = spec.trim().split(/\s+/).slice(0, 4).join(' ');
  return words || 'New Add-on';
}

/**
 * Parse a free-text spec into a buildable UCC project. Always produces a
 * modular-input add-on (the input-bearing path) so the loop has real source to
 * validate and fix. Recognised keywords add config fields.
 */
export function parseSpec(spec: string): ParsedSpec {
  const text = (spec || '').trim();
  const title = titleFromSpec(text);
  const baseId = slug(title);
  const appId = baseId.startsWith('ta_') ? baseId : `TA_${baseId}`;

  const components: ComponentsConfig = JSON.parse(JSON.stringify(DEFAULT_COMPONENTS_CONFIG));

  // Derive a SHORT input name from the spec (e.g. "collect github repos" ->
  // github_repos). UCC input/stanza names must be concise; cap at the first two
  // meaningful words so a verbose spec can't produce an over-long, invalid name.
  const firstTwoWords = (s: string) => s.trim().split(/\s+/).slice(0, 2).join(' ');
  const inputName =
    slug(
      firstTwoWords(
        text.match(/collect(?:s|ing)?\s+([a-z0-9 ]{3,40})/i)?.[1] ||
          text.match(/\b([a-z0-9]+(?:\s+[a-z0-9]+)?)\s+(?:data|events|logs|metrics)/i)?.[1] ||
          baseId
      ).trim()
    ) || 'data';

  const fields: ComponentsConfig['inputs'][number]['entity'] = [];
  const lower = text.toLowerCase();
  if (/\b(api|token|key|bearer|secret)\b/.test(lower)) {
    fields.push({
      field: 'api_token',
      label: 'API Token',
      type: 'password',
      required: true,
      encrypted: true,
      help: 'Authentication token for the API.',
    });
  }
  if (/\b(url|endpoint|host|server|base url)\b/.test(lower)) {
    fields.push({
      field: 'endpoint',
      label: 'Endpoint URL',
      type: 'text',
      required: true,
      help: 'Base URL of the data source.',
    });
  }
  if (/\b(org|organisation|organization|account|tenant|repo|repository|project)\b/.test(lower)) {
    fields.push({
      field: 'target',
      label: 'Target',
      type: 'text',
      required: false,
      help: 'Org / account / repository to collect from.',
    });
  }

  components.inputs.push({
    name: inputName,
    title: title,
    description: text.slice(0, 200),
    entity: fields,
  });

  const metadata: AppMetadata = {
    name: appId,
    displayName: title,
    description: text || `${title} — built with the UCC App Builder agentic loop.`,
    author: 'livehybrid',
    email: '',
    version: '1.0.0',
    appId,
    licenseName: 'Apache-2.0',
    licenseUri: 'https://www.apache.org/licenses/LICENSE-2.0',
  };

  const branding: BrandingConfig = { navBarColor: '#65A637', logoFile: null };

  return { metadata, branding, components };
}

/** Built-in example specs for the panel (hermetic, no LLM). */
export const EXAMPLE_SPECS: { label: string; spec: string }[] = [
  {
    label: 'GitHub audit input',
    spec: 'Build a Splunk add-on "GitHub Audit" that collects github repository audit events from the GitHub API using an api token for a given org.',
  },
  {
    label: 'Weather metrics input',
    spec: 'Create an add-on "Weather Metrics" that collects weather metrics from a REST endpoint url with an api key.',
  },
  {
    label: 'Minimal input (no config)',
    spec: 'Build an add-on "Telemetry Collector" that collects telemetry data.',
  },
];
