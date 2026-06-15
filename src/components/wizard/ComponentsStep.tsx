import { useState, useCallback } from 'react';
import styled from 'styled-components';
import Button from '@splunk/react-ui/Button';
import ControlGroup from '@splunk/react-ui/ControlGroup';
import Text from '@splunk/react-ui/Text';
import Select from '@splunk/react-ui/Select';
import Switch from '@splunk/react-ui/Switch';
import Heading from '@splunk/react-ui/Heading';
import TabLayout from '@splunk/react-ui/TabLayout';
import CollapsiblePanel from '@splunk/react-ui/CollapsiblePanel';
import Chip from '@splunk/react-ui/Chip';
import ColumnLayout from '@splunk/react-ui/ColumnLayout';
import SplunkNumber from '@splunk/react-ui/Number';
import { EntityBuilder } from './EntityBuilder';
import Cross from '@splunk/react-icons/Cross';
import { TemplateGallery } from '../TemplateGallery';
import type { Template } from '../../types/templates';
import { applyTemplate } from '../../lib/templateApplicator';
import {
  createDefaultInputConfig,
  createDefaultCommandConfig,
  createDefaultAlertActionConfig,
  createDefaultAccountConfig,
  createDefaultRestEndpointConfig,
  COMMAND_TYPES,
  ENTITY_TYPES,
} from '../../types/components';
import type {
  ComponentsConfig,
  ModularInputConfig,
  CustomCommandConfig,
  AlertActionConfig,
  AccountConfig,
  RestEndpointConfig,
  AuthType,
  EntityType,
  LogLevel,
} from '../../types/components';

interface ComponentsStepProps {
  config: ComponentsConfig;
  onChange: (config: ComponentsConfig) => void;
}

const ComponentItem = styled.div`
  margin-bottom: 8px;
`;

const ComponentHeaderRow = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
`;

const ComponentName = styled.span`
  font-weight: 600;
`;

const ComponentId = styled.span`
  color: #9b9ea3;
  font-family: 'Splunk Platform Mono', Inconsolata, Consolas, monospace;
  font-size: 0.85rem;
  flex: 1;
`;

const CheckboxGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
  margin-top: 16px;
`;

const MethodChips = styled.div`
  display: flex;
  gap: 8px;
`;

const FieldRow = styled.div`
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
  align-items: flex-end;
`;

import { OAuthWizard, OAuthConfiguration } from './OAuthWizard';

export function ComponentsStep({ config, onChange }: ComponentsStepProps) {
  const [activeTab, setActiveTab] = useState('inputs');
  const [openPanels, setOpenPanels] = useState<Set<string>>(new Set());
  const [isTemplateGalleryOpen, setIsTemplateGalleryOpen] = useState(false);

  // OAuth Wizard state
  const [isOAuthWizardOpen, setIsOAuthWizardOpen] = useState(false);
  const [activeAccountIndex, setActiveAccountIndex] = useState<number | null>(null);

  const openOAuthWizard = (index: number) => {
    setActiveAccountIndex(index);
    setIsOAuthWizardOpen(true);
  };

  const handleOAuthSave = (oauthConfig: OAuthConfiguration) => {
    if (activeAccountIndex !== null) {
      const newAccounts = [...config.accounts];
      const acc = newAccounts[activeAccountIndex];

      // Map wizard config to account config
      const updatedAccount = {
        ...acc,
        authType:
          oauthConfig.authType === 'oauth2'
            ? 'oauth'
            : oauthConfig.authType === 'api_key'
              ? 'apikey'
              : 'basic',
        name: oauthConfig.label
          ? oauthConfig.label.toLowerCase().replace(/[^a-z0-9]/g, '_')
          : acc.name,
        oauth:
          oauthConfig.authType === 'oauth2'
            ? {
                clientId: oauthConfig.clientId,
                clientSecret: oauthConfig.clientSecret,
                authUrl: oauthConfig.authUrl,
                tokenUrl: oauthConfig.tokenUrl,
                redirectUri: oauthConfig.redirectUri,
                scopes: oauthConfig.scopes,
              }
            : undefined,
      } as AccountConfig; // Cast to ensure compatibility

      // Add default fields based on type if missing
      if (oauthConfig.authType === 'oauth2') {
        // OAuth usually just needs the redirect helper, fields are hidden or managed by triggers
      } else if (oauthConfig.authType === 'api_key') {
        // Ensure api_key field exists
        if (!updatedAccount.fields.some((f) => f.field === 'api_key')) {
          updatedAccount.fields.push({
            field: 'api_key',
            label: 'API Key',
            type: 'text',
            required: true,
            encrypted: true,
          });
        }
      }

      onChange({ ...config, accounts: newAccounts });
    }
    setIsOAuthWizardOpen(false);
    setActiveAccountIndex(null);
  };

  // Handle template selection
  const handleTemplateSelect = useCallback(
    (template: Template) => {
      const result = applyTemplate(config, template);
      onChange(result.config);

      // Open panels for newly added inputs
      const newInputCount = result.config.inputs.length;
      const originalInputCount = config.inputs.length;
      if (newInputCount > originalInputCount) {
        setOpenPanels((prev) => {
          const next = new Set(prev);
          for (let i = originalInputCount; i < newInputCount; i++) {
            next.add(`input-${i}`);
          }
          return next;
        });
      }
    },
    [config, onChange]
  );

  const togglePanel = (key: string) => {
    setOpenPanels((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // --- Modular Inputs ---
  const addInput = () => {
    const newInputs = [...config.inputs, createDefaultInputConfig()];
    onChange({ ...config, inputs: newInputs });
    setOpenPanels((prev) => new Set([...prev, `input-${newInputs.length - 1}`]));
  };
  const updateInput = (
    index: number,
    field: keyof ModularInputConfig,
    value: ModularInputConfig[keyof ModularInputConfig]
  ) => {
    const newInputs = [...config.inputs];
    newInputs[index] = { ...newInputs[index], [field]: value };
    onChange({ ...config, inputs: newInputs });
  };
  const removeInput = (index: number) => {
    const newInputs = [...config.inputs];
    newInputs.splice(index, 1);
    onChange({ ...config, inputs: newInputs });
  };

  // --- Custom Commands ---
  const addCommand = () => {
    const newCommands = [...config.commands, createDefaultCommandConfig()];
    onChange({ ...config, commands: newCommands });
    setOpenPanels((prev) => new Set([...prev, `cmd-${newCommands.length - 1}`]));
  };
  const updateCommand = (
    index: number,
    field: keyof CustomCommandConfig,
    value: CustomCommandConfig[keyof CustomCommandConfig]
  ) => {
    const newCommands = [...config.commands];
    newCommands[index] = { ...newCommands[index], [field]: value };
    onChange({ ...config, commands: newCommands });
  };
  const removeCommand = (index: number) => {
    const newCommands = [...config.commands];
    newCommands.splice(index, 1);
    onChange({ ...config, commands: newCommands });
  };

  // --- Alert Actions ---
  const addAlertAction = () => {
    const newAlerts = [...config.alertActions, createDefaultAlertActionConfig()];
    onChange({ ...config, alertActions: newAlerts });
    setOpenPanels((prev) => new Set([...prev, `alert-${newAlerts.length - 1}`]));
  };
  const updateAlertAction = (
    index: number,
    field: keyof AlertActionConfig,
    value: AlertActionConfig[keyof AlertActionConfig]
  ) => {
    const newAlerts = [...config.alertActions];
    newAlerts[index] = { ...newAlerts[index], [field]: value };
    onChange({ ...config, alertActions: newAlerts });
  };
  const removeAlertAction = (index: number) => {
    const newAlerts = [...config.alertActions];
    newAlerts.splice(index, 1);
    onChange({ ...config, alertActions: newAlerts });
  };

  // --- Auth/Account ---
  const addAccount = () => {
    const newAccounts = [...config.accounts, createDefaultAccountConfig()];
    onChange({ ...config, accounts: newAccounts });
    setOpenPanels((prev) => new Set([...prev, `auth-${newAccounts.length - 1}`]));
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateAccount = (index: number, field: keyof AccountConfig, value: any) => {
    const newAccounts = [...config.accounts];
    newAccounts[index] = { ...newAccounts[index], [field]: value };
    onChange({ ...config, accounts: newAccounts });
  };
  const removeAccount = (index: number) => {
    const newAccounts = [...config.accounts];
    newAccounts.splice(index, 1);
    onChange({ ...config, accounts: newAccounts });
  };
  const updateAccountField = (
    accountIndex: number,
    fieldIndex: number,
    prop: string,
    value: string | boolean
  ) => {
    const newAccounts = [...config.accounts];
    const fields = [...newAccounts[accountIndex].fields];
    fields[fieldIndex] = { ...fields[fieldIndex], [prop]: value };
    newAccounts[accountIndex] = { ...newAccounts[accountIndex], fields };
    onChange({ ...config, accounts: newAccounts });
  };

  // --- REST Endpoints ---
  const addRestEndpoint = () => {
    const newEndpoints = [...config.restEndpoints, createDefaultRestEndpointConfig()];
    onChange({ ...config, restEndpoints: newEndpoints });
    setOpenPanels((prev) => new Set([...prev, `rest-${newEndpoints.length - 1}`]));
  };
  const updateRestEndpoint = (
    index: number,
    field: keyof RestEndpointConfig,
    value: RestEndpointConfig[keyof RestEndpointConfig]
  ) => {
    const newEndpoints = [...config.restEndpoints];
    newEndpoints[index] = { ...newEndpoints[index], [field]: value };
    onChange({ ...config, restEndpoints: newEndpoints });
  };
  const removeRestEndpoint = (index: number) => {
    const newEndpoints = [...config.restEndpoints];
    newEndpoints.splice(index, 1);
    onChange({ ...config, restEndpoints: newEndpoints });
  };
  const toggleRestMethod = (index: number, method: 'GET' | 'POST' | 'PUT' | 'DELETE') => {
    const endpoint = config.restEndpoints[index];
    const methods = new Set(endpoint.methods);
    if (methods.has(method)) methods.delete(method);
    else methods.add(method);
    updateRestEndpoint(index, 'methods', Array.from(methods));
  };

  return (
    <div>
      <TabLayout
        activePanelId={activeTab}
        onChange={(_e: unknown, { activePanelId }: { activePanelId?: string }) => {
          if (activePanelId) {
            setActiveTab(activePanelId);
            setOpenPanels(new Set());
          }
        }}
      >
        {/* Modular Inputs Tab */}
        <TabLayout.Panel label={`Modular Inputs (${config.inputs.length})`} panelId="inputs">
          <div style={{ padding: '16px 0' }}>
            <Heading level={3}>Modular Inputs</Heading>
            <p style={{ color: '#9b9ea3', fontSize: '0.875rem', marginBottom: 16 }}>
              Define inputs to collect data from external sources.
            </p>

            {config.inputs.map((input, index) => (
              <ComponentItem key={index}>
                <CollapsiblePanel
                  title={
                    <ComponentHeaderRow>
                      <ComponentName>{input.title || '(Untitled Input)'}</ComponentName>
                      <ComponentId>{input.name}</ComponentId>
                    </ComponentHeaderRow>
                  }
                  open={openPanels.has(`input-${index}`)}
                  onChange={() => togglePanel(`input-${index}`)}
                  actions={
                    <Button
                      appearance="destructive"
                      icon={<Cross />}
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        removeInput(index);
                      }}
                    />
                  }
                >
                  <div style={{ padding: '16px 0' }}>
                    <ControlGroup label="Input Name (Internal ID)" labelPosition="top">
                      <Text
                        value={input.name}
                        onChange={(_e: unknown, { value }: { value: string }) =>
                          updateInput(index, 'name', value)
                        }
                        placeholder="e.g. my_input"
                      />
                    </ControlGroup>
                    <ControlGroup label="Display Title" labelPosition="top">
                      <Text
                        value={input.title}
                        onChange={(_e: unknown, { value }: { value: string }) =>
                          updateInput(index, 'title', value)
                        }
                        placeholder="e.g. My Data Input"
                      />
                    </ControlGroup>
                    <ControlGroup label="Description" labelPosition="top">
                      <Text
                        value={input.description || ''}
                        onChange={(_e: unknown, { value }: { value: string }) =>
                          updateInput(index, 'description', value)
                        }
                        placeholder="Description shown in UI"
                      />
                    </ControlGroup>
                    <EntityBuilder
                      entities={input.entity}
                      onChange={(entities) => updateInput(index, 'entity', entities)}
                    />
                  </div>
                </CollapsiblePanel>
              </ComponentItem>
            ))}

            <div style={{ display: 'flex', gap: '12px', marginTop: '8px' }}>
              <Button appearance="primary" onClick={addInput} label="+ Add Modular Input" />
              <Button
                appearance="secondary"
                onClick={() => setIsTemplateGalleryOpen(true)}
                label="🧰 Use Template"
              />
            </div>
          </div>
        </TabLayout.Panel>

        {/* Template Gallery Modal */}
        <TemplateGallery
          isOpen={isTemplateGalleryOpen}
          onClose={() => setIsTemplateGalleryOpen(false)}
          onSelectTemplate={handleTemplateSelect}
        />

        {/* Custom Commands Tab */}
        <TabLayout.Panel label={`Commands (${config.commands.length})`} panelId="commands">
          <div style={{ padding: '16px 0' }}>
            <Heading level={3}>Custom Commands</Heading>
            <p style={{ color: '#9b9ea3', fontSize: '0.875rem', marginBottom: 16 }}>
              Define custom SPL commands to process data.
            </p>

            {config.commands.map((cmd, index) => (
              <ComponentItem key={index}>
                <CollapsiblePanel
                  title={
                    <ComponentHeaderRow>
                      <ComponentName>{cmd.name || '(Untitled Command)'}</ComponentName>
                      <ComponentId>{cmd.filename}</ComponentId>
                    </ComponentHeaderRow>
                  }
                  open={openPanels.has(`cmd-${index}`)}
                  onChange={() => togglePanel(`cmd-${index}`)}
                  actions={
                    <Button
                      appearance="destructive"
                      icon={<Cross />}
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        removeCommand(index);
                      }}
                    />
                  }
                >
                  <div style={{ padding: '16px 0' }}>
                    <ColumnLayout>
                      <ColumnLayout.Row>
                        <ColumnLayout.Column span={6}>
                          <ControlGroup label="Command Name" labelPosition="top">
                            <Text
                              value={cmd.name}
                              onChange={(_e: unknown, { value }: { value: string }) =>
                                updateCommand(index, 'name', value)
                              }
                              placeholder="e.g. mycommand"
                            />
                          </ControlGroup>
                        </ColumnLayout.Column>
                        <ColumnLayout.Column span={6}>
                          <ControlGroup label="Filename (.py)" labelPosition="top">
                            <Text
                              value={cmd.filename}
                              onChange={(_e: unknown, { value }: { value: string }) =>
                                updateCommand(index, 'filename', value)
                              }
                              placeholder="e.g. my_command.py"
                            />
                          </ControlGroup>
                        </ColumnLayout.Column>
                      </ColumnLayout.Row>
                    </ColumnLayout>

                    <ControlGroup label="Command Type" labelPosition="top">
                      <Select
                        value={cmd.type}
                        onChange={(_e: unknown, { value }: { value: string | number | boolean }) =>
                          updateCommand(index, 'type', String(value))
                        }
                      >
                        {COMMAND_TYPES.map((t) => (
                          <Select.Option
                            key={t.type}
                            label={`${t.label} - ${t.description}`}
                            value={t.type}
                          />
                        ))}
                      </Select>
                    </ControlGroup>

                    <CheckboxGrid>
                      <Switch
                        selected={cmd.chunked}
                        onClick={() => updateCommand(index, 'chunked', !cmd.chunked)}
                        appearance="toggle"
                      >
                        Chunked Protocol
                      </Switch>
                      <Switch
                        selected={cmd.passauth}
                        onClick={() => updateCommand(index, 'passauth', !cmd.passauth)}
                        appearance="toggle"
                      >
                        Pass Auth
                      </Switch>
                      <Switch
                        selected={cmd.supports_multivalues}
                        onClick={() =>
                          updateCommand(index, 'supports_multivalues', !cmd.supports_multivalues)
                        }
                        appearance="toggle"
                      >
                        Multi-values
                      </Switch>
                    </CheckboxGrid>
                  </div>
                </CollapsiblePanel>
              </ComponentItem>
            ))}

            <Button appearance="primary" onClick={addCommand} label="+ Add Custom Command" />
          </div>
        </TabLayout.Panel>

        {/* Alert Actions Tab */}
        <TabLayout.Panel label={`Alert Actions (${config.alertActions.length})`} panelId="alerts">
          <div style={{ padding: '16px 0' }}>
            <Heading level={3}>Alert Actions</Heading>
            <p style={{ color: '#9b9ea3', fontSize: '0.875rem', marginBottom: 16 }}>
              Define custom actions that can be triggered by alerts.
            </p>

            {config.alertActions.map((alert, index) => (
              <ComponentItem key={index}>
                <CollapsiblePanel
                  title={
                    <ComponentHeaderRow>
                      <ComponentName>{alert.label || '(Untitled Alert)'}</ComponentName>
                      <ComponentId>{alert.name}</ComponentId>
                    </ComponentHeaderRow>
                  }
                  open={openPanels.has(`alert-${index}`)}
                  onChange={() => togglePanel(`alert-${index}`)}
                  actions={
                    <Button
                      appearance="destructive"
                      icon={<Cross />}
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        removeAlertAction(index);
                      }}
                    />
                  }
                >
                  <div style={{ padding: '16px 0' }}>
                    <ControlGroup label="Alert Action Name" labelPosition="top">
                      <Text
                        value={alert.name}
                        onChange={(_e: unknown, { value }: { value: string }) =>
                          updateAlertAction(index, 'name', value)
                        }
                        placeholder="e.g. send_to_service"
                      />
                    </ControlGroup>
                    <ControlGroup label="Display Label" labelPosition="top">
                      <Text
                        value={alert.label}
                        onChange={(_e: unknown, { value }: { value: string }) =>
                          updateAlertAction(index, 'label', value)
                        }
                        placeholder="e.g. Send to Service"
                      />
                    </ControlGroup>
                    <ControlGroup label="Description" labelPosition="top">
                      <Text
                        value={alert.description || ''}
                        onChange={(_e: unknown, { value }: { value: string }) =>
                          updateAlertAction(index, 'description', value)
                        }
                      />
                    </ControlGroup>
                    <EntityBuilder
                      entities={alert.entity}
                      onChange={(entities) => updateAlertAction(index, 'entity', entities)}
                    />
                  </div>
                </CollapsiblePanel>
              </ComponentItem>
            ))}

            <Button appearance="primary" onClick={addAlertAction} label="+ Add Alert Action" />
          </div>
        </TabLayout.Panel>

        {/* Authentication Tab */}
        <TabLayout.Panel label={`Auth (${config.accounts.length})`} panelId="auth">
          <div style={{ padding: '16px 0' }}>
            <Heading level={3}>Authentication &amp; Accounts</Heading>
            <p style={{ color: '#9b9ea3', fontSize: '0.875rem', marginBottom: 16 }}>
              Define how users configure credentials for your app.
            </p>

            {config.accounts.map((account, index) => (
              <ComponentItem key={index}>
                <CollapsiblePanel
                  title={
                    <ComponentHeaderRow>
                      <ComponentName>{account.name || 'Global Account'}</ComponentName>
                      <ComponentId>{account.authType}</ComponentId>
                    </ComponentHeaderRow>
                  }
                  open={openPanels.has(`auth-${index}`)}
                  onChange={() => togglePanel(`auth-${index}`)}
                  actions={
                    <Button
                      appearance="destructive"
                      icon={<Cross />}
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        removeAccount(index);
                      }}
                    />
                  }
                >
                  <div style={{ padding: '16px 0' }}>
                    <ControlGroup label="Config Name" labelPosition="top">
                      <Text
                        value={account.name}
                        onChange={(_e: unknown, { value }: { value: string }) =>
                          updateAccount(index, 'name', value)
                        }
                        placeholder="e.g. account"
                      />
                    </ControlGroup>

                    <ControlGroup label="Authentication Type" labelPosition="top">
                      <Select
                        value={account.authType}
                        onChange={(_e: unknown, { value }: { value: string | number | boolean }) =>
                          updateAccount(index, 'authType', String(value) as AuthType)
                        }
                      >
                        <Select.Option label="Basic (Username/Password)" value="basic" />
                        <Select.Option label="OAuth 2.0" value="oauth" />
                        <Select.Option label="API Key" value="apikey" />
                      </Select>
                    </ControlGroup>

                    <Heading level={4} style={{ marginTop: 16 }}>
                      Configuration Fields
                    </Heading>
                    {account.fields.map((field, fIndex) => (
                      <FieldRow key={fIndex}>
                        <Text
                          value={field.label}
                          onChange={(_e: unknown, { value }: { value: string }) =>
                            updateAccountField(index, fIndex, 'label', value)
                          }
                          placeholder="Label"
                          style={{ flex: 1 }}
                        />
                        <Select
                          value={field.type}
                          onChange={(
                            _e: unknown,
                            { value }: { value: string | number | boolean }
                          ) =>
                            updateAccountField(index, fIndex, 'type', String(value) as EntityType)
                          }
                          style={{ width: 160 }}
                        >
                          {ENTITY_TYPES.map((t) => (
                            <Select.Option key={t.type} label={t.label} value={t.type} />
                          ))}
                        </Select>
                        <Switch
                          selected={field.required}
                          onClick={() =>
                            updateAccountField(index, fIndex, 'required', !field.required)
                          }
                          appearance="toggle"
                        >
                          Req
                        </Switch>
                      </FieldRow>
                    ))}

                    {account.authType === 'oauth' && (
                      <div style={{ marginTop: 16 }}>
                        <Heading level={4}>OAuth Configuration</Heading>
                        <ControlGroup label="Redirect URI" labelPosition="top">
                          <Text
                            value={account.oauth?.redirectUri || ''}
                            onChange={(_e: unknown, { value }: { value: string }) =>
                              updateAccount(index, 'oauth', {
                                ...account.oauth,
                                redirectUri: value,
                              })
                            }
                          />
                        </ControlGroup>
                      </div>
                    )}

                    <div style={{ marginTop: 16 }}>
                      <Button
                        appearance="secondary"
                        label="🪄 Open Auth Wizard"
                        onClick={() => openOAuthWizard(index)}
                      />
                    </div>
                  </div>
                </CollapsiblePanel>
              </ComponentItem>
            ))}

            <Button appearance="primary" onClick={addAccount} label="+ Add Account Config" />
          </div>
        </TabLayout.Panel>

        {/* REST Endpoints Tab */}
        <TabLayout.Panel label={`REST (${config.restEndpoints.length})`} panelId="rest">
          <div style={{ padding: '16px 0' }}>
            <Heading level={3}>Custom REST Endpoints</Heading>
            <p style={{ color: '#9b9ea3', fontSize: '0.875rem', marginBottom: 16 }}>
              Define custom API endpoints handled by Python scripts.
            </p>

            {config.restEndpoints.map((endpoint, index) => (
              <ComponentItem key={index}>
                <CollapsiblePanel
                  title={
                    <ComponentHeaderRow>
                      <ComponentName>{endpoint.name || '(Untitled Endpoint)'}</ComponentName>
                      <ComponentId>{endpoint.handlerClass}</ComponentId>
                    </ComponentHeaderRow>
                  }
                  open={openPanels.has(`rest-${index}`)}
                  onChange={() => togglePanel(`rest-${index}`)}
                  actions={
                    <Button
                      appearance="destructive"
                      icon={<Cross />}
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        removeRestEndpoint(index);
                      }}
                    />
                  }
                >
                  <div style={{ padding: '16px 0' }}>
                    <ColumnLayout>
                      <ColumnLayout.Row>
                        <ColumnLayout.Column span={6}>
                          <ControlGroup label="Endpoint Name" labelPosition="top">
                            <Text
                              value={endpoint.name}
                              onChange={(_e: unknown, { value }: { value: string }) =>
                                updateRestEndpoint(index, 'name', value)
                              }
                              placeholder="e.g. my_endpoint"
                            />
                          </ControlGroup>
                        </ColumnLayout.Column>
                        <ColumnLayout.Column span={6}>
                          <ControlGroup label="Handler Class" labelPosition="top">
                            <Text
                              value={endpoint.handlerClass}
                              onChange={(_e: unknown, { value }: { value: string }) =>
                                updateRestEndpoint(index, 'handlerClass', value)
                              }
                              placeholder="e.g. MyHandler"
                            />
                          </ControlGroup>
                        </ColumnLayout.Column>
                      </ColumnLayout.Row>
                    </ColumnLayout>

                    <ControlGroup label="Supported Methods" labelPosition="top">
                      <MethodChips>
                        {(['GET', 'POST', 'PUT', 'DELETE'] as const).map((method) => (
                          <Chip
                            key={method}
                            onClick={() => toggleRestMethod(index, method)}
                            appearance={endpoint.methods.includes(method) ? 'success' : 'outline'}
                          >
                            {method}
                          </Chip>
                        ))}
                      </MethodChips>
                    </ControlGroup>

                    <ControlGroup label="Require Authentication" labelPosition="top">
                      <Switch
                        selected={endpoint.requiresAuth}
                        onClick={() =>
                          updateRestEndpoint(index, 'requiresAuth', !endpoint.requiresAuth)
                        }
                        appearance="toggle"
                      >
                        {endpoint.requiresAuth ? 'Yes' : 'No'}
                      </Switch>
                    </ControlGroup>
                  </div>
                </CollapsiblePanel>
              </ComponentItem>
            ))}

            <Button appearance="primary" onClick={addRestEndpoint} label="+ Add REST Endpoint" />
          </div>
        </TabLayout.Panel>

        {/* Logging Tab */}
        <TabLayout.Panel label="Logging" panelId="logging">
          <div style={{ padding: '16px 0' }}>
            <Heading level={3}>Logging Configuration</Heading>
            <p style={{ color: '#9b9ea3', fontSize: '0.875rem', marginBottom: 16 }}>
              Configure the logging tab that appears in the Configuration page.
            </p>

            <ControlGroup label="Enable Logging Tab" labelPosition="top">
              <Switch
                selected={config.logging.enabled}
                onClick={() =>
                  onChange({
                    ...config,
                    logging: { ...config.logging, enabled: !config.logging.enabled },
                  })
                }
                appearance="toggle"
              >
                {config.logging.enabled ? 'Enabled' : 'Disabled'}
              </Switch>
            </ControlGroup>

            {config.logging.enabled && (
              <>
                <ControlGroup label="Default Log Level" labelPosition="top">
                  <Select
                    value={config.logging.defaultLevel}
                    onChange={(_e: unknown, { value }: { value: string | number | boolean }) =>
                      onChange({
                        ...config,
                        logging: { ...config.logging, defaultLevel: String(value) as LogLevel },
                      })
                    }
                  >
                    <Select.Option label="DEBUG" value="DEBUG" />
                    <Select.Option label="INFO" value="INFO" />
                    <Select.Option label="WARNING" value="WARNING" />
                    <Select.Option label="ERROR" value="ERROR" />
                    <Select.Option label="CRITICAL" value="CRITICAL" />
                  </Select>
                </ControlGroup>

                <ControlGroup
                  label="Log Rotation Size (MB)"
                  labelPosition="top"
                  help="Maximum log file size before rotation."
                >
                  <SplunkNumber
                    value={config.logging.rotationSize ?? 25}
                    onChange={(_e: unknown, { value }: { value?: number }) =>
                      onChange({ ...config, logging: { ...config.logging, rotationSize: value } })
                    }
                  />
                </ControlGroup>

                <ControlGroup
                  label="Retention Count"
                  labelPosition="top"
                  help="Number of rotated log files to keep."
                >
                  <SplunkNumber
                    value={config.logging.retentionCount ?? 5}
                    onChange={(_e: unknown, { value }: { value?: number }) =>
                      onChange({ ...config, logging: { ...config.logging, retentionCount: value } })
                    }
                  />
                </ControlGroup>
              </>
            )}
          </div>
        </TabLayout.Panel>

        {/* Proxy Tab */}
        <TabLayout.Panel label="Proxy" panelId="proxy">
          <div style={{ padding: '16px 0' }}>
            <Heading level={3}>Proxy Configuration</Heading>
            <p style={{ color: '#9b9ea3', fontSize: '0.875rem', marginBottom: 16 }}>
              Configure the proxy tab that appears in the Configuration page.
            </p>

            <ControlGroup label="Enable Proxy Tab" labelPosition="top">
              <Switch
                selected={config.proxy.enabled}
                onClick={() =>
                  onChange({
                    ...config,
                    proxy: { ...config.proxy, enabled: !config.proxy.enabled },
                  })
                }
                appearance="toggle"
              >
                {config.proxy.enabled ? 'Enabled' : 'Disabled'}
              </Switch>
            </ControlGroup>

            {config.proxy.enabled && (
              <>
                <ControlGroup label="Proxy Type" labelPosition="top">
                  <Select
                    value={config.proxy.proxyType}
                    onChange={(_e: unknown, { value }: { value: string | number | boolean }) =>
                      onChange({
                        ...config,
                        proxy: {
                          ...config.proxy,
                          proxyType: String(value) as 'http' | 'socks4' | 'socks5',
                        },
                      })
                    }
                  >
                    <Select.Option label="HTTP" value="http" />
                    <Select.Option label="SOCKS4" value="socks4" />
                    <Select.Option label="SOCKS5" value="socks5" />
                  </Select>
                </ControlGroup>

                <ColumnLayout>
                  <ColumnLayout.Row>
                    <ColumnLayout.Column span={8}>
                      <ControlGroup label="Proxy Host" labelPosition="top">
                        <Text
                          value={config.proxy.host}
                          onChange={(_e: unknown, { value }: { value: string }) =>
                            onChange({ ...config, proxy: { ...config.proxy, host: value } })
                          }
                          placeholder="proxy.example.com"
                        />
                      </ControlGroup>
                    </ColumnLayout.Column>
                    <ColumnLayout.Column span={4}>
                      <ControlGroup label="Port" labelPosition="top">
                        <Text
                          value={config.proxy.port}
                          onChange={(_e: unknown, { value }: { value: string }) =>
                            onChange({ ...config, proxy: { ...config.proxy, port: value } })
                          }
                          placeholder="8080"
                        />
                      </ControlGroup>
                    </ColumnLayout.Column>
                  </ColumnLayout.Row>
                  <ColumnLayout.Row>
                    <ColumnLayout.Column span={6}>
                      <ControlGroup label="Username (optional)" labelPosition="top">
                        <Text
                          value={config.proxy.username || ''}
                          onChange={(_e: unknown, { value }: { value: string }) =>
                            onChange({ ...config, proxy: { ...config.proxy, username: value } })
                          }
                        />
                      </ControlGroup>
                    </ColumnLayout.Column>
                    <ColumnLayout.Column span={6}>
                      <ControlGroup label="Password (optional)" labelPosition="top">
                        <Text
                          value={config.proxy.password || ''}
                          onChange={(_e: unknown, { value }: { value: string }) =>
                            onChange({ ...config, proxy: { ...config.proxy, password: value } })
                          }
                        />
                      </ControlGroup>
                    </ColumnLayout.Column>
                  </ColumnLayout.Row>
                </ColumnLayout>

                {config.proxy.proxyType === 'socks5' && (
                  <ControlGroup label="Reverse DNS" labelPosition="top">
                    <Switch
                      selected={config.proxy.rdns ?? false}
                      onClick={() =>
                        onChange({
                          ...config,
                          proxy: { ...config.proxy, rdns: !config.proxy.rdns },
                        })
                      }
                      appearance="toggle"
                    >
                      {config.proxy.rdns ? 'Enabled' : 'Disabled'}
                    </Switch>
                  </ControlGroup>
                )}
              </>
            )}
          </div>
        </TabLayout.Panel>

        {/* Custom Config Tabs */}
        <TabLayout.Panel label={`Custom (${config.customTabs.length})`} panelId="custom">
          <div style={{ padding: '16px 0' }}>
            <Heading level={3}>Custom Configuration Tabs</Heading>
            <p style={{ color: '#9b9ea3', fontSize: '0.875rem', marginBottom: 16 }}>
              Add custom configuration tabs to the app&apos;s Configuration page.
            </p>

            {config.customTabs.map((tab, index) => (
              <ComponentItem key={index}>
                <CollapsiblePanel
                  title={
                    <ComponentHeaderRow>
                      <ComponentName>{tab.title || '(Untitled Tab)'}</ComponentName>
                      <ComponentId>{tab.name}</ComponentId>
                    </ComponentHeaderRow>
                  }
                  open={openPanels.has(`custom-${index}`)}
                  onChange={() => togglePanel(`custom-${index}`)}
                  actions={
                    <Button
                      appearance="destructive"
                      icon={<Cross />}
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        const newTabs = [...config.customTabs];
                        newTabs.splice(index, 1);
                        onChange({ ...config, customTabs: newTabs });
                      }}
                    />
                  }
                >
                  <div style={{ padding: '16px 0' }}>
                    <ControlGroup label="Tab Name (Internal ID)" labelPosition="top">
                      <Text
                        value={tab.name}
                        onChange={(_e: unknown, { value }: { value: string }) => {
                          const newTabs = [...config.customTabs];
                          newTabs[index] = { ...tab, name: value };
                          onChange({ ...config, customTabs: newTabs });
                        }}
                        placeholder="e.g. custom_settings"
                      />
                    </ControlGroup>
                    <ControlGroup label="Display Title" labelPosition="top">
                      <Text
                        value={tab.title}
                        onChange={(_e: unknown, { value }: { value: string }) => {
                          const newTabs = [...config.customTabs];
                          newTabs[index] = { ...tab, title: value };
                          onChange({ ...config, customTabs: newTabs });
                        }}
                        placeholder="e.g. Custom Settings"
                      />
                    </ControlGroup>
                    <EntityBuilder
                      entities={tab.entity}
                      onChange={(entities) => {
                        const newTabs = [...config.customTabs];
                        newTabs[index] = { ...tab, entity: entities };
                        onChange({ ...config, customTabs: newTabs });
                      }}
                    />
                  </div>
                </CollapsiblePanel>
              </ComponentItem>
            ))}

            <Button
              appearance="primary"
              onClick={() => {
                const newTabs = [...config.customTabs, { name: '', title: '', entity: [] }];
                onChange({ ...config, customTabs: newTabs });
                setOpenPanels((prev) => new Set([...prev, `custom-${newTabs.length - 1}`]));
              }}
              label="+ Add Custom Tab"
            />
          </div>
        </TabLayout.Panel>
      </TabLayout>

      {isOAuthWizardOpen && (
        <OAuthWizard
          open={isOAuthWizardOpen}
          onClose={() => setIsOAuthWizardOpen(false)}
          onSave={handleOAuthSave}
          initialConfig={
            activeAccountIndex !== null && config.accounts[activeAccountIndex]
              ? {
                  authType:
                    config.accounts[activeAccountIndex].authType === 'oauth'
                      ? 'oauth2'
                      : config.accounts[activeAccountIndex].authType === 'apikey'
                        ? 'api_key'
                        : 'basic',
                  label: config.accounts[activeAccountIndex].name,
                  clientId: config.accounts[activeAccountIndex].oauth?.clientId
                    ? String(config.accounts[activeAccountIndex].oauth?.clientId)
                    : undefined,
                  clientSecret: config.accounts[activeAccountIndex].oauth?.clientSecret
                    ? String(config.accounts[activeAccountIndex].oauth?.clientSecret)
                    : undefined,
                  authUrl: config.accounts[activeAccountIndex].oauth?.authUrl,
                  tokenUrl: config.accounts[activeAccountIndex].oauth?.tokenUrl,
                  redirectUri: config.accounts[activeAccountIndex].oauth?.redirectUri,
                  scopes: config.accounts[activeAccountIndex].oauth?.scope
                    ? [config.accounts[activeAccountIndex].oauth?.scope]
                    : undefined,
                }
              : undefined
          }
        />
      )}
    </div>
  );
}
