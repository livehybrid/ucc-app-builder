/**
 * UCC Entity field types and component configurations
 */

export type EntityType =
  | 'text'
  | 'password'
  | 'checkbox'
  | 'singleSelect'
  | 'multipleSelect'
  | 'radio'
  | 'textarea'
  | 'file'
  | 'oauth'
  | 'helpLink';

export type ValidatorType = 'string' | 'number' | 'regex' | 'url' | 'email' | 'ipv4' | 'date';

export interface EntityValidator {
  type: ValidatorType;
  errorMsg?: string;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  pattern?: string;
}

export interface SelectOption {
  label: string;
  value: string;
}

export interface EntityField {
  field: string;
  label: string;
  type: EntityType;
  required?: boolean;
  defaultValue?: string | number | boolean;
  help?: string;
  tooltip?: string;
  encrypted?: boolean;
  validators?: EntityValidator[];
  options?: {
    placeholder?: string;
    disableonalidate?: boolean;
    items?: SelectOption[];
    autoCompleteFields?: string[];
    endpointUrl?: string;
    allowList?: string;
    denyList?: string;
    createSearchChoice?: boolean;
    referenceName?: string;
    dependencies?: string[];
    labelField?: string;
    valueField?: string;
  };
}

export interface ModularInputConfig {
  name: string;
  title: string;
  description?: string;
  entity: EntityField[];
  services?: ServiceConfig[];
}

export interface ServiceConfig {
  name: string;
  title: string;
  entity: EntityField[];
}

export interface CustomCommandConfig {
  name: string;
  filename: string;
  type: 'streaming' | 'reporting' | 'generating' | 'eventing';
  chunked?: boolean;
  maxinputs?: number;
  passauth?: boolean;
  enableheader?: boolean;
  requires_srinfo?: boolean;
  supports_getinfo?: boolean;
  supports_rawargs?: boolean;
  supports_multivalues?: boolean;
}

export interface AlertActionConfig {
  name: string;
  label: string;
  description?: string;
  iconPath?: string;
  entity: EntityField[];
  isAdaptiveResponse?: boolean;
}

export type AuthType = 'basic' | 'oauth' | 'apikey';

export interface AccountFieldConfig {
  field: string;
  label: string;
  type: EntityType;
  required?: boolean;
  help?: string;
  encrypted?: boolean;
}

export interface AccountConfig {
  name: string;
  authType: AuthType;
  fields: AccountFieldConfig[];
  // OAuth specific
  oauth?: {
    clientId: boolean;
    clientSecret: boolean;
    redirectUri?: string;
    authUrl?: string;
    tokenUrl?: string;
    scope?: string;
  };
}

export interface RestEndpointConfig {
  name: string;
  handlerClass: string;
  methods: ('GET' | 'POST' | 'PUT' | 'DELETE')[];
  requiresAuth: boolean;
  description?: string;
}

export type LogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';

export interface LoggingConfig {
  enabled: boolean;
  defaultLevel: LogLevel;
  rotationSize?: number; // MB
  retentionCount?: number;
}

export interface ProxyConfig {
  enabled: boolean;
  proxyType: 'http' | 'socks4' | 'socks5';
  host: string;
  port: string;
  username?: string;
  password?: string;
  rdns?: boolean;
}

export interface CustomConfigTab {
  name: string;
  title: string;
  entity: EntityField[];
}

/**
 * Complete component configuration for the wizard
 */
export interface ComponentsConfig {
  inputs: ModularInputConfig[];
  commands: CustomCommandConfig[];
  alertActions: AlertActionConfig[];
  accounts: AccountConfig[];
  restEndpoints: RestEndpointConfig[];
  logging: LoggingConfig;
  proxy: ProxyConfig;
  customTabs: CustomConfigTab[];
}

export const DEFAULT_COMPONENTS_CONFIG: ComponentsConfig = {
  inputs: [],
  commands: [],
  alertActions: [],
  accounts: [],
  restEndpoints: [],
  logging: {
    enabled: false,
    defaultLevel: 'INFO',
  },
  proxy: {
    enabled: false,
    proxyType: 'http',
    host: '',
    port: '',
  },
  customTabs: [],
};

/**
 * Available entity types with descriptions
 */
export const ENTITY_TYPES: { type: EntityType; label: string; description: string }[] = [
  { type: 'text', label: 'Text', description: 'Single-line text input' },
  { type: 'password', label: 'Password', description: 'Masked password input' },
  { type: 'checkbox', label: 'Checkbox', description: 'Boolean toggle' },
  { type: 'singleSelect', label: 'Dropdown', description: 'Single selection dropdown' },
  { type: 'multipleSelect', label: 'Multi-Select', description: 'Multiple selection dropdown' },
  { type: 'radio', label: 'Radio', description: 'Radio button group' },
  { type: 'textarea', label: 'Text Area', description: 'Multi-line text input' },
  { type: 'file', label: 'File', description: 'File upload' },
];

/**
 * Available validator types
 */
export const VALIDATOR_TYPES: { type: ValidatorType; label: string }[] = [
  { type: 'string', label: 'String (length)' },
  { type: 'number', label: 'Number (range)' },
  { type: 'regex', label: 'Regex Pattern' },
  { type: 'url', label: 'URL' },
  { type: 'email', label: 'Email' },
  { type: 'ipv4', label: 'IPv4 Address' },
  { type: 'date', label: 'Date' },
];

/**
 * Command types for custom commands
 */
export const COMMAND_TYPES: {
  type: CustomCommandConfig['type'];
  label: string;
  description: string;
}[] = [
  { type: 'streaming', label: 'Streaming', description: 'Processes events one at a time' },
  { type: 'reporting', label: 'Reporting', description: 'Processes all events before returning' },
  { type: 'generating', label: 'Generating', description: 'Creates new events from scratch' },
  { type: 'eventing', label: 'Eventing', description: 'Modifies events in-place' },
];

/**
 * Create a default entity field
 */
export function createDefaultEntityField(): EntityField {
  return {
    field: '',
    label: '',
    type: 'text',
    required: false,
  };
}

/**
 * Create a default modular input config
 */
export function createDefaultInputConfig(): ModularInputConfig {
  return {
    name: '',
    title: '',
    description: '',
    entity: [
      {
        field: 'name',
        label: 'Name',
        type: 'text',
        required: true,
        help: 'Unique name for this input',
      },
      {
        field: 'interval',
        label: 'Interval',
        type: 'text',
        required: true,
        help: 'Collection interval in seconds',
      },
      { field: 'index', label: 'Index', type: 'text', required: true, help: 'Destination index' },
    ],
  };
}

/**
 * Create a default custom command config
 */
export function createDefaultCommandConfig(): CustomCommandConfig {
  return {
    name: '',
    filename: '',
    type: 'streaming',
    chunked: true,
  };
}

/**
 * Create a default alert action config
 */
export function createDefaultAlertActionConfig(): AlertActionConfig {
  return {
    name: '',
    label: '',
    description: '',
    entity: [],
  };
}

/**
 * Create a default account config
 */
export function createDefaultAccountConfig(): AccountConfig {
  return {
    name: '',
    authType: 'basic',
    fields: [
      { field: 'account_name', label: 'Account Name', type: 'text', required: true },
      { field: 'username', label: 'Username', type: 'text', required: true },
      { field: 'password', label: 'Password', type: 'password', required: true, encrypted: true },
    ],
  };
}

/**
 * Create a default REST endpoint config
 */
export function createDefaultRestEndpointConfig(): RestEndpointConfig {
  return {
    name: '',
    handlerClass: '',
    methods: ['GET'],
    requiresAuth: true,
  };
}
