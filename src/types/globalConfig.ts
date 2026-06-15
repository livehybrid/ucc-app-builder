/**
 * UCC globalConfig.json type definitions
 * Based on the UCC framework schema
 */

import type { ComponentsConfig } from './components';

interface GlobalConfigMeta {
  name: string;
  restRoot: string;
  version: string;
  displayName: string;
  schemaVersion: string;
  supportedThemes?: string[];
  checkForUpdates?: boolean;
}

interface GlobalConfigPage {
  title: string;
  description?: string;
  tabs?: GlobalConfigTab[];
  table?: GlobalConfigTable;
  services?: GlobalConfigService[];
}

interface GlobalConfigTab {
  name: string;
  title: string;
  entity?: GlobalConfigEntity[];
}

interface GlobalConfigEntity {
  type: string;
  label: string;
  field: string;
  required?: boolean;
  help?: string;
  encrypted?: boolean;
  defaultValue?: string | number | boolean;
  options?: Record<string, unknown>;
  validators?: GlobalConfigValidator[];
}

interface GlobalConfigValidator {
  type: string;
  errorMsg?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

interface GlobalConfigTable {
  header: GlobalConfigTableHeader[];
  actions: string[];
}

interface GlobalConfigTableHeader {
  label: string;
  field: string;
}

interface GlobalConfigService {
  name: string;
  title: string;
  entity: GlobalConfigEntity[];
  inputHelperModule?: string;
}

interface GlobalConfigAlertAction {
  name: string;
  label: string;
  description?: string;
  icon?: string;
  entity: GlobalConfigEntity[];
}

interface GlobalConfigDashboard {
  panels: Array<{ name: string }>;
}

interface GlobalConfig {
  meta: GlobalConfigMeta;
  pages: {
    configuration?: GlobalConfigPage;
    inputs?: GlobalConfigPage;
    dashboard?: GlobalConfigDashboard;
  };
  alerts?: GlobalConfigAlertAction[];
}

/**
 * Convert an EntityField to a GlobalConfigEntity
 */
function entityFieldToGlobalConfig(f: import('./components').EntityField): GlobalConfigEntity {
  // UCC has NO `password` entity type — a secret field is a `text` entity with
  // `encrypted: true`. The wizard/MCP use a friendly `password` type, so we translate
  // it here. Passing `type: "password"` straight through makes the globalConfig fail
  // ucc-gen schema validation ("is not valid under any of the given schemas").
  const isPassword = f.type === 'password';
  const entity: GlobalConfigEntity = {
    type: isPassword ? 'text' : f.type,
    label: f.label,
    field: f.field,
    required: f.required,
    help: f.help,
    encrypted: isPassword ? true : f.encrypted,
    defaultValue: f.defaultValue,
  };

  // Build options object based on entity type
  const options: Record<string, unknown> = {};
  let hasOptions = false;

  if (f.options?.placeholder) {
    options.placeholder = f.options.placeholder;
    hasOptions = true;
  }

  // Types that need items: singleSelect, multipleSelect, radio
  if (['singleSelect', 'multipleSelect', 'radio'].includes(f.type)) {
    if (f.options?.items && f.options.items.length > 0) {
      options.items = f.options.items;
      hasOptions = true;
    }

    if (f.type === 'singleSelect' || f.type === 'multipleSelect') {
      if (f.options?.autoCompleteFields) {
        options.autoCompleteFields = f.options.autoCompleteFields;
        hasOptions = true;
      }
      if (f.options?.endpointUrl) {
        options.endpointUrl = f.options.endpointUrl;
        hasOptions = true;
      }
      if (f.options?.labelField) {
        options.labelField = f.options.labelField;
        hasOptions = true;
      }
      if (f.options?.valueField) {
        options.valueField = f.options.valueField;
        hasOptions = true;
      }
      if (f.options?.referenceName) {
        options.referenceName = f.options.referenceName;
        hasOptions = true;
      }
      if (f.options?.dependencies) {
        options.dependencies = f.options.dependencies;
        hasOptions = true;
      }
    }

    if (f.type === 'multipleSelect') {
      if (f.options?.createSearchChoice) {
        options.createSearchChoice = f.options.createSearchChoice;
        hasOptions = true;
      }
      if (f.options?.allowList) {
        options.allowList = f.options.allowList;
        hasOptions = true;
      }
      if (f.options?.denyList) {
        options.denyList = f.options.denyList;
        hasOptions = true;
      }
    }
  }

  // File type options
  if (f.type === 'file') {
    // UCC file entity typically uses supportedFileTypes, maxFileSize, etc.
    // These would be in f.options if set
    if (f.options) {
      Object.entries(f.options).forEach(([key, value]) => {
        if (value !== undefined && value !== '') {
          options[key] = value;
          hasOptions = true;
        }
      });
    }
  }

  // Checkbox type -- enable/disable labels
  if (f.type === 'checkbox') {
    if (f.options) {
      Object.entries(f.options).forEach(([key, value]) => {
        if (value !== undefined && value !== '') {
          options[key] = value;
          hasOptions = true;
        }
      });
    }
  }

  if (hasOptions) {
    entity.options = options;
  }

  // Map validators
  if (f.validators && f.validators.length > 0) {
    entity.validators = f.validators.map((v) => {
      const validator: GlobalConfigValidator = { type: v.type };
      if (v.errorMsg) validator.errorMsg = v.errorMsg;
      if (v.pattern) validator.pattern = v.pattern;
      if (v.minLength !== undefined) validator.minLength = v.minLength;
      if (v.maxLength !== undefined) validator.maxLength = v.maxLength;
      return validator;
    });
  }

  return entity;
}

/**
 * Standard modular-input fields every UCC input needs. `name` is the stanza key;
 * `interval` and `index` are the canonical data-collection knobs and are also the
 * columns the inputs table renders. They MUST be declared as entities or ucc-gen /
 * AppInspect treat the table header as referencing undeclared fields.
 */
function standardInputEntities(): import('./components').EntityField[] {
  return [
    {
      field: 'name',
      label: 'Name',
      type: 'text',
      required: true,
      help: 'Unique name for this input.',
    },
    {
      field: 'interval',
      label: 'Interval',
      type: 'text',
      required: true,
      help: 'Collection interval, in seconds (or a cron schedule).',
    },
    {
      field: 'index',
      label: 'Index',
      type: 'singleSelect',
      required: true,
      help: 'Destination index for collected events.',
      defaultValue: 'default',
      options: { createSearchChoice: true, items: [{ label: 'default', value: 'default' }] },
    },
  ];
}

/**
 * Guarantee an input declares the standard `name`/`interval`/`index` entities (in
 * that order, first) without clobbering any the caller already supplied. This keeps
 * the inputs table.header valid even when an input is created via the MCP `add_input`
 * tool with an empty or partial field list.
 */
function ensureInputEntities(
  entity: import('./components').EntityField[]
): import('./components').EntityField[] {
  const present = new Set((entity ?? []).map((e) => e.field));
  const prepend = standardInputEntities().filter((e) => !present.has(e.field));
  return [...prepend, ...(entity ?? [])];
}

/**
 * Create globalConfig from wizard state
 */
export function createGlobalConfig(
  appId: string,
  displayName: string,
  version: string,
  components: ComponentsConfig
): GlobalConfig {
  const config: GlobalConfig = {
    meta: {
      name: appId,
      restRoot: appId,
      version,
      displayName,
      // Highest version accepted by the installed ucc-gen (6.4.x) — ucc-gen
      // migrates older values forward on build, but author at current.
      schemaVersion: '0.0.10',
      supportedThemes: ['light', 'dark'],
      // AppInspect rule check_for_updates_disabled requires check_for_updates=false
      // in app.conf; ucc-gen renders that from this flag, so bake it in up front
      // rather than letting the AppInspect loop patch it on iteration 1.
      checkForUpdates: false,
    },
    pages: {},
  };

  // 1. Configuration Page (Account/Auth + Logging + Proxy + Custom Tabs)
  const configTabs: GlobalConfigTab[] = [];

  // Account tabs
  components.accounts.forEach((account) => {
    configTabs.push({
      name: account.name || 'account',
      title: account.name
        ? account.name.charAt(0).toUpperCase() + account.name.slice(1)
        : 'Account',
      // Map `password` -> `text` + encrypted (UCC has no password entity type).
      entity: account.fields.map((f) => ({
        type: f.type === 'password' ? 'text' : f.type,
        label: f.label,
        field: f.field,
        required: f.required,
        help: f.help,
        encrypted: f.type === 'password' ? true : f.encrypted,
      })),
    });
  });

  // Logging tab
  if (components.logging?.enabled) {
    configTabs.push({
      name: 'logging',
      title: 'Logging',
      entity: [
        {
          type: 'singleSelect',
          label: 'Log Level',
          field: 'loglevel',
          defaultValue: components.logging.defaultLevel || 'INFO',
          help: 'Select the log level for this add-on.',
          options: {
            items: [
              { label: 'DEBUG', value: 'DEBUG' },
              { label: 'INFO', value: 'INFO' },
              { label: 'WARNING', value: 'WARNING' },
              { label: 'ERROR', value: 'ERROR' },
              { label: 'CRITICAL', value: 'CRITICAL' },
            ],
          },
        },
      ],
    });
  }

  // Proxy tab
  if (components.proxy?.enabled) {
    configTabs.push({
      name: 'proxy',
      title: 'Proxy',
      entity: [
        {
          type: 'checkbox',
          label: 'Enable Proxy',
          field: 'proxy_enabled',
          help: 'Enable or disable proxy for data collection.',
        },
        {
          type: 'singleSelect',
          label: 'Proxy Type',
          field: 'proxy_type',
          defaultValue: components.proxy.proxyType || 'http',
          options: {
            items: [
              { label: 'HTTP', value: 'http' },
              { label: 'SOCKS4', value: 'socks4' },
              { label: 'SOCKS5', value: 'socks5' },
            ],
          },
        },
        { type: 'text', label: 'Host', field: 'proxy_url', required: true },
        { type: 'text', label: 'Port', field: 'proxy_port', required: true },
        { type: 'text', label: 'Username', field: 'proxy_username' },
        { type: 'password', label: 'Password', field: 'proxy_password', encrypted: true },
        ...(components.proxy.proxyType === 'socks5'
          ? [{ type: 'checkbox', label: 'Reverse DNS', field: 'proxy_rdns' }]
          : []),
      ],
    });
  }

  // Custom tabs
  components.customTabs?.forEach((tab) => {
    configTabs.push({
      name: tab.name,
      title: tab.title,
      entity: tab.entity.map(entityFieldToGlobalConfig),
    });
  });

  if (configTabs.length > 0) {
    config.pages.configuration = {
      title: 'Configuration',
      tabs: configTabs,
    };
  }

  // 2. Inputs Page
  if (components.inputs.length > 0) {
    const inputServices: GlobalConfigService[] = components.inputs.map((input) => ({
      name: input.name,
      title: input.title || input.name,
      // Every modular input MUST declare at least `name`, plus `interval`/`index`
      // (the standard data-collection fields). UCC requires every column referenced
      // by the inputs table.header to be a declared entity (`disabled` is the one
      // exception UCC injects automatically). An input added via the MCP `add_input`
      // tool may arrive with an empty/partial entity list, so we normalise here so
      // the generated globalConfig is always schema-valid and ucc-gen builds clean.
      entity: ensureInputEntities(input.entity).map(entityFieldToGlobalConfig),
      inputHelperModule: `${input.name}_helper`,
    }));

    config.pages.inputs = {
      title: 'Inputs',
      description: 'Manage your data inputs',
      services: inputServices,
      table: {
        // Only `name` + `disabled` are guaranteed columns. `interval`/`index` are
        // included because ensureInputEntities() guarantees they are declared on
        // every service. `disabled` is the status column UCC injects.
        header: [
          { label: 'Name', field: 'name' },
          { label: 'Interval', field: 'interval' },
          { label: 'Index', field: 'index' },
          { label: 'Status', field: 'disabled' },
        ],
        // Valid InputsTable actions are ONLY edit/delete/clone/search ('enable'
        // is not in the schema enum — enable/disable comes from the `disabled`
        // status column automatically). ucc-gen 6.5+ rejects invalid actions.
        actions: ['edit', 'delete', 'clone'],
      },
    };

    // Add dashboard page
    config.pages.dashboard = {
      panels: [{ name: 'default' }],
    };
  }

  // 3. Alert Actions
  if (components.alertActions.length > 0) {
    config.alerts = components.alertActions.map((alert) => ({
      name: alert.name,
      label: alert.label,
      description: alert.description,
      icon: alert.iconPath || 'appIcon.png',
      entity: alert.entity.map(entityFieldToGlobalConfig),
    }));
  }

  return config;
}
