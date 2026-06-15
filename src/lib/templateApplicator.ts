/**
 * Template Applicator
 *
 * Applies a template to the current ComponentsConfig, merging inputs, accounts,
 * and recommended settings while avoiding duplicates.
 */

import type { ComponentsConfig, ModularInputConfig, AccountConfig } from '../types/components';
import type { Template } from '../types/templates';

interface ApplyTemplateResult {
  /** Updated components config */
  config: ComponentsConfig;
  /** Python scripts to add to VFS { path: content } */
  scriptsToAdd: Record<string, string>;
  /** Summary of what was added */
  summary: string[];
}

/**
 * Generate a unique name for an input if it already exists
 */
function makeUniqueName(baseName: string, existingNames: Set<string>): string {
  if (!existingNames.has(baseName)) {
    return baseName;
  }

  let counter = 2;
  while (existingNames.has(`${baseName}_${counter}`)) {
    counter++;
  }
  return `${baseName}_${counter}`;
}

/**
 * Convert input name to Python class name
 */
function toClassName(name: string): string {
  return (
    name
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join('') + 'Input'
  );
}

/**
 * Hydrate Python script template with actual values
 */
function hydratePythonScript(template: string, input: ModularInputConfig): string {
  return template
    .replace(/\{\{INPUT_NAME\}\}/g, input.name)
    .replace(/\{\{INPUT_TITLE\}\}/g, input.title)
    .replace(/\{\{CLASS_NAME\}\}/g, toClassName(input.name))
    .replace(/\{\{INPUT_DESCRIPTION\}\}/g, input.description || '');
}

/**
 * Apply a template to the current configuration
 */
export function applyTemplate(
  currentConfig: ComponentsConfig,
  template: Template
): ApplyTemplateResult {
  const summary: string[] = [];
  const scriptsToAdd: Record<string, string> = {};

  // Track existing names to avoid duplicates
  const existingInputNames = new Set(currentConfig.inputs.map((i) => i.name));
  const existingAccountNames = new Set(currentConfig.accounts.map((a) => a.name));

  // Process template inputs
  const newInputs: ModularInputConfig[] = [];

  for (const templateInput of template.inputs) {
    // Create a copy with unique name if needed
    const baseName = templateInput.config.name;
    const uniqueName = makeUniqueName(baseName, existingInputNames);
    existingInputNames.add(uniqueName);

    const inputConfig: ModularInputConfig = {
      ...templateInput.config,
      name: uniqueName,
      title:
        uniqueName === baseName
          ? templateInput.config.title
          : `${templateInput.config.title} (${uniqueName})`,
    };

    newInputs.push(inputConfig);
    summary.push(`Added input: "${inputConfig.title}"`);

    // Generate Python script
    const scriptPath = `package/bin/${uniqueName}.py`;
    const hydratedScript = hydratePythonScript(templateInput.pythonScript, inputConfig);
    scriptsToAdd[scriptPath] = hydratedScript;
    summary.push(`Added script: bin/${uniqueName}.py`);

    // Generate helper script if provided
    if (templateInput.helperScript) {
      const helperPath = `package/bin/${uniqueName}_helper.py`;
      scriptsToAdd[helperPath] = templateInput.helperScript;
      summary.push(`Added helper: bin/${uniqueName}_helper.py`);
    }
  }

  // Process template accounts
  const newAccounts: AccountConfig[] = [];

  if (template.accounts) {
    for (const templateAccount of template.accounts) {
      const baseName = templateAccount.config.name;

      // Skip if account with same name exists
      if (existingAccountNames.has(baseName)) {
        summary.push(`Skipped account "${baseName}" (already exists)`);
        continue;
      }

      existingAccountNames.add(baseName);
      newAccounts.push({ ...templateAccount.config });
      summary.push(`Added account: "${templateAccount.config.name}"`);
    }
  }

  // Apply recommended settings
  let logging = currentConfig.logging;
  let proxy = currentConfig.proxy;

  if (template.recommendedTabs?.enableLogging && !currentConfig.logging.enabled) {
    logging = { ...currentConfig.logging, enabled: true };
    summary.push('Enabled logging configuration');
  }

  if (template.recommendedTabs?.enableProxy && !currentConfig.proxy.enabled) {
    proxy = { ...currentConfig.proxy, enabled: true };
    summary.push('Enabled proxy configuration');
  }

  // Build updated config
  const config: ComponentsConfig = {
    ...currentConfig,
    inputs: [...currentConfig.inputs, ...newInputs],
    accounts: [...currentConfig.accounts, ...newAccounts],
    logging,
    proxy,
  };

  return {
    config,
    scriptsToAdd,
    summary,
  };
}
