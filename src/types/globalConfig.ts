/**
 * UCC globalConfig.json type definitions
 * Based on the UCC framework schema
 */

import type { ComponentsConfig } from './components';

export interface GlobalConfigMeta {
  name: string;
  restRoot: string;
  version: string;
  displayName: string;
  schemaVersion: string;
}

export interface GlobalConfigPage {
  title: string;
  tabs?: GlobalConfigTab[];
  table?: GlobalConfigTable;
  services?: GlobalConfigService[];
}

export interface GlobalConfigTab {
  name: string;
  title: string;
  entity?: GlobalConfigEntity[];
}

export interface GlobalConfigEntity {
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

export interface GlobalConfigValidator {
  type: string;
  errorMsg?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

export interface GlobalConfigTable {
  header: GlobalConfigTableHeader[];
  actions: string[];
}

export interface GlobalConfigTableHeader {
  label: string;
  field: string;
}

export interface GlobalConfigService {
  name: string;
  title: string;
  entity: GlobalConfigEntity[];
}

export interface GlobalConfigAlertAction {
  name: string;
  label: string;
  description?: string;
  icon?: string;
  entity: GlobalConfigEntity[];
}

export interface GlobalConfig {
  meta: GlobalConfigMeta;
  pages: {
    configuration?: GlobalConfigPage;
    inputs?: GlobalConfigPage;
  };
  alerts?: GlobalConfigAlertAction[];
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
      schemaVersion: '0.0.3',
    },
    pages: {},
  };

  // 1. Configuration Page (Account/Auth)
  if (components.accounts.length > 0) {
    config.pages.configuration = {
      title: 'Configuration',
      tabs: components.accounts.map(account => ({
        name: account.name || 'account',
        title: account.name ? account.name.charAt(0).toUpperCase() + account.name.slice(1) : 'Account',
        entity: account.fields.map(f => ({
          type: f.type,
          label: f.label,
          field: f.field,
          required: f.required,
          help: f.help,
          encrypted: f.encrypted,
        })),
      })),
    };
  }

  // 2. Inputs Page
  if (components.inputs.length > 0) {
    const inputServices: GlobalConfigService[] = components.inputs.map(input => ({
      name: input.name,
      title: input.title,
      entity: input.entity.map(f => ({
        type: f.type,
        label: f.label,
        field: f.field,
        required: f.required,
        defaultValue: f.defaultValue,
        help: f.help,
        validators: f.validators?.map(v => ({
          type: v.type,
          errorMsg: v.errorMsg,
          pattern: v.pattern,
          minLength: v.minLength,
          maxLength: v.maxLength,
        })),
      })),
    }));

    config.pages.inputs = {
      title: 'Inputs',
      services: inputServices,
      table: {
        header: [
          { label: 'Name', field: 'name' },
          { label: 'Index', field: 'index' },
          { label: 'Interval', field: 'interval' },
          { label: 'Status', field: 'disabled' },
        ],
        actions: ['edit', 'enable', 'delete', 'clone'],
      },
    };
  }

  // 3. Alert Actions
  if (components.alertActions.length > 0) {
    config.alerts = components.alertActions.map(alert => ({
      name: alert.name,
      label: alert.label,
      description: alert.description,
      icon: alert.iconPath || 'appIcon.png',
      entity: alert.entity.map(f => ({
        type: f.type,
        label: f.label,
        field: f.field,
        required: f.required,
        defaultValue: f.defaultValue,
        help: f.help,
        validators: f.validators?.map(v => ({
          type: v.type,
          errorMsg: v.errorMsg,
          pattern: v.pattern,
          minLength: v.minLength,
          maxLength: v.maxLength,
        })),
      })),
    }));
  }

  return config;
}
