import { describe, it, expect } from 'vitest';
import {
  createDefaultEntityField,
  createDefaultInputConfig,
  createDefaultCommandConfig,
  createDefaultAlertActionConfig,
  createDefaultAccountConfig,
  createDefaultRestEndpointConfig,
  DEFAULT_COMPONENTS_CONFIG,
  ENTITY_TYPES,
  VALIDATOR_TYPES,
  COMMAND_TYPES,
} from './components';

describe('createDefaultEntityField', () => {
  it('should create field with empty strings and text type', () => {
    const field = createDefaultEntityField();
    expect(field.field).toBe('');
    expect(field.label).toBe('');
    expect(field.type).toBe('text');
    expect(field.required).toBe(false);
  });
});

describe('createDefaultInputConfig', () => {
  it('should create input with empty name and title', () => {
    const input = createDefaultInputConfig();
    expect(input.name).toBe('');
    expect(input.title).toBe('');
  });

  it('should include default entity fields (name, interval, index)', () => {
    const input = createDefaultInputConfig();
    expect(input.entity).toHaveLength(3);
    const fieldNames = input.entity.map((e) => e.field);
    expect(fieldNames).toContain('name');
    expect(fieldNames).toContain('interval');
    expect(fieldNames).toContain('index');
  });

  it('should have all default entity fields as required', () => {
    const input = createDefaultInputConfig();
    expect(input.entity.every((e) => e.required)).toBe(true);
  });
});

describe('createDefaultCommandConfig', () => {
  it('should create streaming command by default', () => {
    const cmd = createDefaultCommandConfig();
    expect(cmd.type).toBe('streaming');
    expect(cmd.chunked).toBe(true);
    expect(cmd.name).toBe('');
    expect(cmd.filename).toBe('');
  });
});

describe('createDefaultAlertActionConfig', () => {
  it('should create alert action with empty entity array', () => {
    const alert = createDefaultAlertActionConfig();
    expect(alert.name).toBe('');
    expect(alert.label).toBe('');
    expect(alert.entity).toEqual([]);
  });
});

describe('createDefaultAccountConfig', () => {
  it('should create basic auth account by default', () => {
    const account = createDefaultAccountConfig();
    expect(account.authType).toBe('basic');
    expect(account.name).toBe('');
  });

  it('should include default fields (account_name, username, password)', () => {
    const account = createDefaultAccountConfig();
    expect(account.fields).toHaveLength(3);
    const fieldNames = account.fields.map((f) => f.field);
    expect(fieldNames).toContain('account_name');
    expect(fieldNames).toContain('username');
    expect(fieldNames).toContain('password');
  });

  it('should have password field encrypted', () => {
    const account = createDefaultAccountConfig();
    const pwField = account.fields.find((f) => f.field === 'password');
    expect(pwField?.encrypted).toBe(true);
  });
});

describe('createDefaultRestEndpointConfig', () => {
  it('should create REST endpoint with GET method', () => {
    const endpoint = createDefaultRestEndpointConfig();
    expect(endpoint.methods).toEqual(['GET']);
    expect(endpoint.requiresAuth).toBe(true);
    expect(endpoint.name).toBe('');
  });
});

describe('DEFAULT_COMPONENTS_CONFIG', () => {
  it('should have empty arrays for all collection types', () => {
    expect(DEFAULT_COMPONENTS_CONFIG.inputs).toEqual([]);
    expect(DEFAULT_COMPONENTS_CONFIG.commands).toEqual([]);
    expect(DEFAULT_COMPONENTS_CONFIG.alertActions).toEqual([]);
    expect(DEFAULT_COMPONENTS_CONFIG.accounts).toEqual([]);
    expect(DEFAULT_COMPONENTS_CONFIG.restEndpoints).toEqual([]);
    expect(DEFAULT_COMPONENTS_CONFIG.customTabs).toEqual([]);
  });

  it('should have logging disabled by default', () => {
    expect(DEFAULT_COMPONENTS_CONFIG.logging.enabled).toBe(false);
    expect(DEFAULT_COMPONENTS_CONFIG.logging.defaultLevel).toBe('INFO');
  });

  it('should have proxy disabled by default', () => {
    expect(DEFAULT_COMPONENTS_CONFIG.proxy.enabled).toBe(false);
    expect(DEFAULT_COMPONENTS_CONFIG.proxy.proxyType).toBe('http');
  });
});

describe('constants', () => {
  it('ENTITY_TYPES should have all field types', () => {
    expect(ENTITY_TYPES.length).toBeGreaterThan(0);
    const types = ENTITY_TYPES.map((t) => t.type);
    expect(types).toContain('text');
    expect(types).toContain('password');
    expect(types).toContain('checkbox');
    expect(types).toContain('singleSelect');
  });

  it('VALIDATOR_TYPES should have all validator types', () => {
    expect(VALIDATOR_TYPES.length).toBeGreaterThan(0);
    const types = VALIDATOR_TYPES.map((t) => t.type);
    expect(types).toContain('string');
    expect(types).toContain('number');
    expect(types).toContain('regex');
  });

  it('COMMAND_TYPES should have all command types', () => {
    expect(COMMAND_TYPES.length).toBeGreaterThan(0);
    const types = COMMAND_TYPES.map((t) => t.type);
    expect(types).toContain('streaming');
    expect(types).toContain('reporting');
    expect(types).toContain('generating');
    expect(types).toContain('eventing');
  });
});
