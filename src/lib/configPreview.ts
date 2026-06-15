/**
 * Pure logic behind the globalConfig UI preview: parse the config, normalize
 * tabs (expanding `loggingTab` / `proxyTab` shorthand into real entities, the
 * way ucc-gen does), and evaluate entity validators so the preview can show
 * live validation errors exactly as the built app would.
 */

export interface PreviewEntity {
  type: string;
  field: string;
  label: string;
  help?: string;
  required?: boolean;
  encrypted?: boolean;
  defaultValue?: string | number | boolean;
  options?: Record<string, unknown>;
  validators?: Array<Record<string, unknown>>;
}

export interface PreviewTab {
  name: string;
  title: string;
  entity: PreviewEntity[];
  /** Present for account-style tabs that render a table of entries. */
  table?: { header: Array<{ label: string; field: string }> };
}

export interface PreviewService {
  name: string;
  title: string;
  description?: string;
  entity: PreviewEntity[];
}

export interface PreviewAlert {
  name: string;
  label: string;
  description?: string;
  entity: PreviewEntity[];
}

export interface PreviewModel {
  meta: { name: string; displayName: string; version: string; restRoot: string };
  configurationTabs: PreviewTab[];
  inputServices: PreviewService[];
  alerts: PreviewAlert[];
  hasDashboard: boolean;
  /** pages.inputs / pages.configuration declared at all (drives app-nav items) */
  hasInputsPage: boolean;
  hasConfigurationPage: boolean;
}

/** ucc-gen expands `"type": "loggingTab"` into this standard tab. */
const LOGGING_TAB: PreviewTab = {
  name: 'logging',
  title: 'Logging',
  entity: [
    {
      type: 'singleSelect',
      field: 'loglevel',
      label: 'Log level',
      defaultValue: 'INFO',
      options: {
        disableSearch: true,
        autoCompleteFields: ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'].map((v) => ({
          value: v,
          label: v,
        })),
      },
    },
  ],
};

/** ucc-gen expands `"type": "proxyTab"` into (approximately) this tab. */
const PROXY_TAB: PreviewTab = {
  name: 'proxy',
  title: 'Proxy',
  entity: [
    { type: 'checkbox', field: 'proxy_enabled', label: 'Enable' },
    {
      type: 'singleSelect',
      field: 'proxy_type',
      label: 'Proxy Type',
      defaultValue: 'http',
      options: {
        disableSearch: true,
        autoCompleteFields: ['http', 'socks4', 'socks5'].map((v) => ({ value: v, label: v })),
      },
    },
    { type: 'text', field: 'proxy_url', label: 'Host' },
    {
      type: 'text',
      field: 'proxy_port',
      label: 'Port',
      validators: [{ type: 'number', range: [1, 65535], isInteger: true }],
    },
    { type: 'text', field: 'proxy_username', label: 'Username' },
    { type: 'text', field: 'proxy_password', label: 'Password', encrypted: true },
    { type: 'checkbox', field: 'proxy_rdns', label: 'Reverse DNS resolution' },
  ],
};

function asEntities(raw: unknown): PreviewEntity[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .map((e) => ({
      type: String(e.type ?? 'text'),
      field: String(e.field ?? ''),
      label: String(e.label ?? e.field ?? ''),
      help: typeof e.help === 'string' ? e.help : undefined,
      required: Boolean(e.required),
      encrypted: Boolean(e.encrypted),
      defaultValue: e.defaultValue as PreviewEntity['defaultValue'],
      options:
        e.options && typeof e.options === 'object'
          ? (e.options as Record<string, unknown>)
          : undefined,
      validators: Array.isArray(e.validators)
        ? (e.validators as Array<Record<string, unknown>>)
        : undefined,
    }))
    .filter((e) => e.field || e.type === 'helpLink');
}

/**
 * Parse a raw globalConfig.json string into the preview model.
 * Throws with a readable message on malformed JSON or missing pages.
 */
export function buildPreviewModel(configJson: string): PreviewModel {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(configJson) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`globalConfig.json is not valid JSON: ${(e as Error).message}`);
  }

  const meta = (parsed.meta ?? {}) as Record<string, unknown>;
  const pages = (parsed.pages ?? {}) as Record<string, unknown>;
  const configuration = (pages.configuration ?? {}) as Record<string, unknown>;
  const inputs = (pages.inputs ?? {}) as Record<string, unknown>;

  const configurationTabs: PreviewTab[] = (
    Array.isArray(configuration.tabs) ? configuration.tabs : []
  )
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t) => {
      if (t.type === 'loggingTab') return LOGGING_TAB;
      if (t.type === 'proxyTab') return PROXY_TAB;
      const table = t.table as { header?: Array<{ label: string; field: string }> } | undefined;
      return {
        name: String(t.name ?? ''),
        title: String(t.title ?? t.name ?? ''),
        entity: asEntities(t.entity),
        table: table?.header ? { header: table.header } : undefined,
      };
    })
    .filter((t) => t.name);

  const inputServices: PreviewService[] = (Array.isArray(inputs.services) ? inputs.services : [])
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .map((s) => ({
      name: String(s.name ?? ''),
      title: String(s.title ?? s.name ?? ''),
      description: typeof s.description === 'string' ? s.description : undefined,
      entity: asEntities(s.entity),
    }))
    .filter((s) => s.name);

  const alerts: PreviewAlert[] = (Array.isArray(parsed.alerts) ? parsed.alerts : [])
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
    .map((a) => ({
      name: String(a.name ?? ''),
      label: String(a.label ?? a.name ?? ''),
      description: typeof a.description === 'string' ? a.description : undefined,
      entity: asEntities(a.entity),
    }))
    .filter((a) => a.name);

  return {
    meta: {
      name: String(meta.name ?? ''),
      displayName: String(meta.displayName ?? meta.name ?? 'Untitled add-on'),
      version: String(meta.version ?? ''),
      restRoot: String(meta.restRoot ?? ''),
    },
    configurationTabs,
    inputServices,
    alerts,
    hasDashboard: Boolean(pages.dashboard),
    hasInputsPage: Boolean(pages.inputs),
    hasConfigurationPage: configurationTabs.length > 0,
  };
}

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Evaluate an entity's `required` flag + validators against a value, the way
 * the built UCC UI would. Returns the first error message, or null when valid.
 * Empty optional fields are valid (UCC only validates filled values).
 */
export function validateEntityValue(entity: PreviewEntity, value: unknown): string | null {
  const str = value === undefined || value === null ? '' : String(value);

  if (entity.required && str.trim() === '') {
    return `Field ${entity.label} is required`;
  }
  if (str === '') return null;

  for (const v of entity.validators ?? []) {
    const errorMsg = typeof v.errorMsg === 'string' ? v.errorMsg : null;
    switch (v.type) {
      case 'string': {
        const min = typeof v.minLength === 'number' ? v.minLength : null;
        const max = typeof v.maxLength === 'number' ? v.maxLength : null;
        if (min !== null && str.length < min) {
          return errorMsg ?? `Length of ${entity.label} should be greater than or equal to ${min}`;
        }
        if (max !== null && str.length > max) {
          return errorMsg ?? `Length of ${entity.label} should be less than or equal to ${max}`;
        }
        break;
      }
      case 'regex': {
        const pattern = typeof v.pattern === 'string' ? v.pattern : null;
        if (pattern !== null) {
          try {
            if (!new RegExp(pattern).test(str)) {
              return (
                errorMsg ?? `Field ${entity.label} does not match regular expression ${pattern}`
              );
            }
          } catch {
            return `Validator regex for ${entity.label} is itself invalid: ${pattern}`;
          }
        }
        break;
      }
      case 'number': {
        const n = Number(str);
        if (!Number.isFinite(n)) {
          return errorMsg ?? `Field ${entity.label} is not a number`;
        }
        if (v.isInteger && !Number.isInteger(n)) {
          return errorMsg ?? `Field ${entity.label} is not an integer`;
        }
        const range = Array.isArray(v.range) ? (v.range as number[]) : null;
        if (range && range.length === 2 && (n < range[0] || n > range[1])) {
          return (
            errorMsg ??
            `Field ${entity.label} should be within the range of [${range[0]} and ${range[1]}]`
          );
        }
        break;
      }
      case 'url': {
        try {
          // UCC accepts scheme-less host names for some URL fields; be a bit
          // lenient but reject clearly broken values.
          new URL(str.includes('://') ? str : `https://${str}`);
          if (/\s/.test(str)) throw new Error('whitespace');
        } catch {
          return errorMsg ?? `Field ${entity.label} is not a valid URL`;
        }
        break;
      }
      case 'email': {
        if (!EMAIL_RE.test(str)) {
          return errorMsg ?? `Field ${entity.label} is not a valid email address`;
        }
        break;
      }
      case 'ipv4': {
        if (!IPV4_RE.test(str)) {
          return errorMsg ?? `Field ${entity.label} is not a valid IPV4 address`;
        }
        break;
      }
      case 'date': {
        if (Number.isNaN(Date.parse(str))) {
          return errorMsg ?? `Field ${entity.label} is not a valid date`;
        }
        break;
      }
      default:
        break;
    }
  }

  // The `interval` entity type carries an implicit validator in UCC.
  if (entity.type === 'interval') {
    const n = Number(str);
    const isNumber = Number.isFinite(n) && n >= -1;
    // Loose cron check: 5 space-separated fields.
    const isCron = str.trim().split(/\s+/).length === 5;
    if (!isNumber && !isCron) {
      return `Field ${entity.label} should be a positive number of seconds or a cron expression`;
    }
  }

  return null;
}

/** Seed a form's initial values from entity defaultValues. */
export function initialValues(entities: PreviewEntity[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const e of entities) {
    if (e.defaultValue !== undefined) out[e.field] = e.defaultValue;
    else if (e.type === 'checkbox') out[e.field] = false;
  }
  return out;
}
