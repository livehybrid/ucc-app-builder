/**
 * Expert Expansion — turn a one-line request into a complete, reviewable UCC add-on spec.
 *
 * Agents (LLMs) left to their own devices produce thin add-ons: one input, one field, no
 * auth, no proxy, no CIM. This stage runs BEFORE the build and forces depth — the way a
 * senior Splunk TA developer would scope it — then hands the user an editable spec to
 * approve (the review gate) so the build is grounded in something concrete and correct.
 *
 * This is UCC-tuned (data-collection add-ons / TAs), not dashboard-app generation: the
 * "minimums" are about a COMPLETE add-on — authenticated, proxy-aware, CIM-mapped,
 * checkpointed — not "8 panels". The spec maps directly onto what the agent then authors
 * in globalConfig.json.
 *
 * Shared by BOTH agent paths: the browser expands + reviews here, then seeds whichever
 * build backend (Splunk Agent SDK or the OpenRouter loop) with renderBuildInstruction().
 */

export type UccFieldType = 'text' | 'password' | 'checkbox' | 'singleSelect' | 'number';

export interface UccSpecField {
  /** conf/global-config key, snake_case, e.g. "api_key" */
  name: string;
  label?: string;
  type: UccFieldType;
  required?: boolean;
  /** stored encrypted in storage/passwords (secrets) */
  encrypted?: boolean;
  help?: string;
  defaultValue?: string | number | boolean;
  /** options for singleSelect */
  options?: string[];
}

export type UccAuthType = 'none' | 'api_key' | 'bearer_token' | 'basic' | 'oauth2';

export interface UccSpecAccount {
  authType: UccAuthType;
  /** credential fields (e.g. api_key encrypted, or username + password) */
  fields: UccSpecField[];
  /** allow several named accounts (multi-tenant collection) */
  multipleAccounts?: boolean;
}

export type UccCollection = 'rest_api' | 'modular_input' | 'file_monitor' | 'scripted';

export interface UccSpecInput {
  /** input/stanza name, snake_case, e.g. "api_usage" */
  name: string;
  label?: string;
  collection: UccCollection;
  description?: string;
  /** REST: the endpoint/URL the input polls */
  endpoint?: string;
  /** REST verb, default GET */
  method?: string;
  /** poll interval (seconds) */
  interval?: number;
  /** target sourcetype, e.g. "acme:api:usage" */
  sourcetype?: string;
  /** suggested default index */
  index?: string;
  /** incremental collection keeps a checkpoint (timestamp/cursor) */
  checkpoint?: boolean;
  /** CIM data model this data maps to (e.g. "Web", "Authentication", "Network_Traffic"), or "" */
  cim?: string;
  /** per-input parameters the user configures (besides the account) */
  fields: UccSpecField[];
}

export interface UccSpec {
  /** add-on id, e.g. "TA_acme_logs" (UCC convention) */
  appId: string;
  /** human label, e.g. "Acme Logs Add-on" */
  name: string;
  description?: string;
  vendor?: string;
  defaultIndex?: string;
  account: UccSpecAccount;
  /** include a proxy stanza (host/port/user/pass/type) on the settings page */
  proxy: boolean;
  /** include a logging-level setting */
  loggingLevel: boolean;
  /** include an SSL-verify toggle */
  sslVerify?: boolean;
  inputs: UccSpecInput[];
  /** the operational questions this add-on lets you answer once the data is onboarded */
  questions?: string[];
  /** honest gaps — e.g. "schema not grounded; sourcetype is a best guess" */
  gaps?: string[];
  /** true when fields/sourcetypes were grounded against a live Splunk instance */
  grounded?: boolean;
}

/** Grounding context (live indexes/sourcetypes) to make the spec schema-accurate. */
export interface ExpansionGrounding {
  indexes?: string[];
  sourcetypes?: string[];
}

const MINIMUMS = `MINIMUM COMPLETENESS — a real add-on, never a skeleton:
- At least ONE fully-specified data input (more if the source exposes distinct data sets).
- An account/credential definition with the correct auth type (api_key / bearer_token /
  basic / oauth2) — secrets MUST be marked encrypted. Use "none" ONLY for genuinely
  unauthenticated public sources.
- Proxy support (proxy=true) and a logging-level setting (loggingLevel=true) UNLESS the
  source is local-only; default both to true for any network/API collection.
- An SSL-verify toggle for any HTTPS collection.
- For every input: a descriptive sourcetype (vendor:product:dataset form), a poll interval,
  a checkpoint flag for time-series/incremental sources, and a CIM data model mapping when
  the data clearly fits one (Web, Authentication, Network_Traffic, Change, etc.) — else "".`;

const DIMENSIONS = `THINK LIKE THE ENGINEER WHO WILL RUN THIS ADD-ON. Before writing the spec,
list the operational questions the onboarded data must answer (questions[]). Cover, where
the source allows: current state, trend over time, breakdown by a dimension (host/user/
endpoint/region), comparison to baseline, anomalies, and what action the data drives. Each
question should be answerable from a field you include — if a question needs a field the
source does not expose, record it under gaps[] rather than inventing the field.`;

/** The UCC-tuned expansion system prompt. Strict JSON output matching {@link UccSpec}. */
export function expansionSystemPrompt(): string {
  return `You are a senior Splunk Technology Add-on (TA) developer with deep UCC-framework
experience. You receive a short request and expand it into a COMPLETE, expert-level
specification for a data-collection add-on that a real team would deploy — authenticated,
proxy-aware, checkpointed, and CIM-mapped where it fits.

${MINIMUMS}

${DIMENSIONS}

GROUNDING:
- When AVAILABLE INDEXES / SOURCETYPES are provided, reference REAL ones; set grounded=true.
- Never invent field names you cannot justify from the source; list assumptions in gaps[].
- Name everything specifically — snake_case keys, vendor:product:dataset sourcetypes,
  TA_<vendor>_<product> appId. No "input1" / "field_a" placeholders.

OUTPUT: return ONLY a single JSON object (no markdown fences, no prose) with EXACTLY this
shape:
{
  "appId": "TA_acme_logs",
  "name": "Acme Logs Add-on",
  "description": "one or two sentences",
  "vendor": "Acme",
  "defaultIndex": "main",
  "account": {
    "authType": "api_key|bearer_token|basic|oauth2|none",
    "multipleAccounts": true,
    "fields": [
      {"name": "api_key", "label": "API Key", "type": "password", "required": true, "encrypted": true, "help": "..."}
    ]
  },
  "proxy": true,
  "loggingLevel": true,
  "sslVerify": true,
  "inputs": [
    {
      "name": "api_usage",
      "label": "API Usage",
      "collection": "rest_api|modular_input|file_monitor|scripted",
      "description": "...",
      "endpoint": "https://api.acme.com/v1/usage",
      "method": "GET",
      "interval": 300,
      "sourcetype": "acme:api:usage",
      "index": "main",
      "checkpoint": true,
      "cim": "Web",
      "fields": [
        {"name": "start_date", "label": "Start Date", "type": "text", "required": false, "help": "..."}
      ]
    }
  ],
  "questions": ["Is the 4xx rate increasing?", "Which endpoint drives most usage?"],
  "gaps": ["User-to-owner mapping needs a CMDB lookup not present in the source"],
  "grounded": false
}

KEEP IT FOCUSED so the JSON is not truncated: at most ~6 inputs and ~8 fields per input,
short help strings, ≤8 questions. Completeness over volume — cover the real data sets, not
every conceivable option.

BEFORE RETURNING, verify: at least one complete input; account auth set with secrets
encrypted; proxy+logging decided; every input has sourcetype+interval; questions[] is not
empty; gaps[] is honest. If any check fails, expand further. Output ONLY the JSON object.`;
}

/** Build the user message for the expansion call, optionally including live grounding. */
export function expansionUserPrompt(request: string, grounding?: ExpansionGrounding): string {
  const parts = [`REQUEST: ${request.trim()}`];
  const idx = grounding?.indexes?.filter(Boolean) ?? [];
  const st = grounding?.sourcetypes?.filter(Boolean) ?? [];
  if (idx.length) parts.push(`AVAILABLE INDEXES: ${idx.slice(0, 50).join(', ')}`);
  if (st.length) parts.push(`AVAILABLE SOURCETYPES: ${st.slice(0, 80).join(', ')}`);
  if (!idx.length && !st.length) {
    parts.push(
      'No live Splunk grounding available — choose sensible sourcetypes/index and set grounded=false; note in gaps[] that the schema is not grounded.'
    );
  }
  return parts.join('\n\n');
}

/** Extract the first balanced JSON object from a model reply (tolerates stray prose/fences). */
function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null;
}

const VALID_AUTH: UccAuthType[] = ['none', 'api_key', 'bearer_token', 'basic', 'oauth2'];
const VALID_COLLECTION: UccCollection[] = [
  'rest_api',
  'modular_input',
  'file_monitor',
  'scripted',
];
const VALID_FIELD_TYPES: UccFieldType[] = [
  'text',
  'password',
  'checkbox',
  'singleSelect',
  'number',
];

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : v == null ? fallback : String(v);
}
function asBool(v: unknown): boolean {
  return v === true || v === 'true' || v === 1;
}

function coerceField(raw: unknown): UccSpecField | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = asString(r.name).trim();
  if (!name) return null;
  let type = asString(r.type, 'text') as UccFieldType;
  if (!VALID_FIELD_TYPES.includes(type)) type = 'text';
  const encrypted = asBool(r.encrypted) || type === 'password';
  const field: UccSpecField = {
    name,
    type,
    label: asString(r.label) || undefined,
    required: asBool(r.required) || undefined,
    encrypted: encrypted || undefined,
    help: asString(r.help) || undefined,
  };
  if (r.defaultValue != null && r.defaultValue !== '') {
    field.defaultValue = r.defaultValue as string | number | boolean;
  }
  if (Array.isArray(r.options)) field.options = r.options.map((o) => asString(o)).filter(Boolean);
  return field;
}

function coerceInput(raw: unknown): UccSpecInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = asString(r.name).trim();
  if (!name) return null;
  let collection = asString(r.collection, 'rest_api') as UccCollection;
  if (!VALID_COLLECTION.includes(collection)) collection = 'rest_api';
  const interval = Number(r.interval);
  return {
    name,
    label: asString(r.label) || undefined,
    collection,
    description: asString(r.description) || undefined,
    endpoint: asString(r.endpoint) || undefined,
    method: asString(r.method) || undefined,
    interval: Number.isFinite(interval) && interval > 0 ? Math.round(interval) : undefined,
    sourcetype: asString(r.sourcetype) || undefined,
    index: asString(r.index) || undefined,
    checkpoint: asBool(r.checkpoint) || undefined,
    cim: asString(r.cim) || undefined,
    fields: Array.isArray(r.fields)
      ? r.fields.map(coerceField).filter((f): f is UccSpecField => f !== null)
      : [],
  };
}

/**
 * Parse + normalise a model reply into a {@link UccSpec}. Tolerant of fences and minor
 * shape drift; throws only when there is no usable JSON object at all.
 */
export function parseSpec(text: string): UccSpec {
  const json = extractJsonObject(text);
  if (!json) throw new Error('Expansion produced no JSON spec.');
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`Expansion JSON was invalid: ${(e as Error).message}`);
  }
  const accountRaw = (raw.account ?? {}) as Record<string, unknown>;
  let authType = asString(accountRaw.authType, 'none') as UccAuthType;
  if (!VALID_AUTH.includes(authType)) authType = 'none';
  const account: UccSpecAccount = {
    authType,
    multipleAccounts: asBool(accountRaw.multipleAccounts) || undefined,
    fields: Array.isArray(accountRaw.fields)
      ? accountRaw.fields.map(coerceField).filter((f): f is UccSpecField => f !== null)
      : [],
  };
  const inputs = Array.isArray(raw.inputs)
    ? raw.inputs.map(coerceInput).filter((i): i is UccSpecInput => i !== null)
    : [];

  return {
    appId: asString(raw.appId).trim() || 'TA_my_addon',
    name: asString(raw.name).trim() || 'My Add-on',
    description: asString(raw.description) || undefined,
    vendor: asString(raw.vendor) || undefined,
    defaultIndex: asString(raw.defaultIndex) || undefined,
    account,
    proxy: asBool(raw.proxy),
    loggingLevel: asBool(raw.loggingLevel),
    sslVerify: raw.sslVerify == null ? undefined : asBool(raw.sslVerify),
    inputs,
    questions: Array.isArray(raw.questions)
      ? raw.questions.map((q) => asString(q)).filter(Boolean)
      : undefined,
    gaps: Array.isArray(raw.gaps) ? raw.gaps.map((g) => asString(g)).filter(Boolean) : undefined,
    grounded: asBool(raw.grounded) || undefined,
  };
}

/** Quick completeness warnings for the review gate (non-blocking — guidance, not errors). */
export function specWarnings(spec: UccSpec): string[] {
  const w: string[] = [];
  if (!spec.inputs.length) w.push('No inputs defined — an add-on needs at least one.');
  if (spec.account.authType !== 'none' && spec.account.fields.length === 0) {
    w.push(`Auth is "${spec.account.authType}" but no credential fields are defined.`);
  }
  spec.inputs.forEach((i) => {
    if (!i.sourcetype) w.push(`Input "${i.name}" has no sourcetype.`);
    if (i.collection === 'rest_api' && !i.endpoint)
      w.push(`REST input "${i.name}" has no endpoint.`);
  });
  if (
    spec.account.authType !== 'none' &&
    !spec.account.fields.some((f) => f.encrypted || f.type === 'password')
  ) {
    w.push('No credential field is marked encrypted — secrets should be encrypted.');
  }
  return w;
}

/**
 * Render an approved spec into a precise build instruction that seeds the agent. The agent
 * (Splunk Agent SDK or OpenRouter loop) then authors globalConfig.json to match and runs
 * the AppInspect build loop. We embed the JSON so nothing is lost, plus a prose checklist so
 * the model can't skip parts.
 */
export function renderBuildInstruction(spec: UccSpec): string {
  const lines: string[] = [];
  lines.push(
    `Build a Splunk UCC add-on that EXACTLY matches the following specification, which the user has reviewed and approved. Do not simplify or drop any part of it.`
  );
  lines.push('');
  lines.push(`Add-on: ${spec.name} (appId ${spec.appId})${spec.vendor ? `, vendor ${spec.vendor}` : ''}.`);
  if (spec.description) lines.push(`Purpose: ${spec.description}`);
  lines.push('');
  lines.push('Configuration page:');
  lines.push(
    `- Account tab: auth type "${spec.account.authType}"${spec.account.multipleAccounts ? ' (allow multiple accounts)' : ''} with fields: ${
      spec.account.fields.map((f) => `${f.name}${f.encrypted ? ' (encrypted)' : ''}`).join(', ') || '(none)'
    }.`
  );
  const settings: string[] = [];
  if (spec.proxy) settings.push('proxy (host/port/username/password/type/SSL)');
  if (spec.loggingLevel) settings.push('logging level');
  if (spec.sslVerify) settings.push('SSL verification toggle');
  lines.push(`- Settings tab: ${settings.length ? settings.join(', ') : 'logging level'}.`);
  lines.push('');
  lines.push(`Inputs (${spec.inputs.length}):`);
  spec.inputs.forEach((i) => {
    const bits = [
      `collection ${i.collection}`,
      i.endpoint ? `endpoint ${i.endpoint}` : '',
      i.method ? `method ${i.method}` : '',
      i.interval ? `interval ${i.interval}s` : '',
      i.sourcetype ? `sourcetype ${i.sourcetype}` : '',
      i.index || spec.defaultIndex ? `index ${i.index || spec.defaultIndex}` : '',
      i.checkpoint ? 'checkpointed' : '',
      i.cim ? `CIM ${i.cim}` : '',
    ].filter(Boolean);
    lines.push(`- ${i.name}: ${bits.join('; ')}.`);
    if (i.fields.length) {
      lines.push(`    parameters: ${i.fields.map((f) => `${f.name} (${f.type})`).join(', ')}.`);
    }
  });
  if (spec.defaultIndex) {
    lines.push('');
    lines.push(`Default index: ${spec.defaultIndex}.`);
  }
  lines.push('');
  lines.push(
    'Author globalConfig.json (with "checkForUpdates": false in meta) to match this spec, then run build_and_inspect and self-correct until AppInspect-clean. Implement the collection logic in package/bin/ for each input.'
  );
  lines.push('');
  lines.push('--- APPROVED SPEC (JSON) ---');
  lines.push(JSON.stringify(spec, null, 2));
  return lines.join('\n');
}
