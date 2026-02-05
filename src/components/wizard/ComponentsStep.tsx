import { useState } from 'react';
import { EntityBuilder } from './EntityBuilder';
import {
  createDefaultInputConfig,
  createDefaultCommandConfig,
  createDefaultAlertActionConfig,
  createDefaultAccountConfig,
  createDefaultRestEndpointConfig,
  COMMAND_TYPES,
  ENTITY_TYPES
} from '../../types/components';
import type {
  ComponentsConfig,
  ModularInputConfig,
  CustomCommandConfig,
  AlertActionConfig,
  AccountConfig,
  RestEndpointConfig,
  AuthType,
  EntityType
} from '../../types/components';

interface ComponentsStepProps {
  config: ComponentsConfig;
  onChange: (config: ComponentsConfig) => void;
}

export function ComponentsStep({ config, onChange }: ComponentsStepProps) {
  const [activeTab, setActiveTab] = useState<'inputs' | 'commands' | 'alerts' | 'auth' | 'rest'>('inputs');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  // --- Modular Inputs Logic ---
  const addInput = () => {
    const newInputs = [...config.inputs, createDefaultInputConfig()];
    onChange({ ...config, inputs: newInputs });
    setEditingIndex(newInputs.length - 1);
  };

  const updateInput = (index: number, field: keyof ModularInputConfig, value: any) => {
    const newInputs = [...config.inputs];
    newInputs[index] = { ...newInputs[index], [field]: value };
    onChange({ ...config, inputs: newInputs });
  };

  const removeInput = (index: number) => {
    const newInputs = [...config.inputs];
    newInputs.splice(index, 1);
    onChange({ ...config, inputs: newInputs });
    setEditingIndex(null);
  };

  // --- Custom Commands Logic ---
  const addCommand = () => {
    const newCommands = [...config.commands, createDefaultCommandConfig()];
    onChange({ ...config, commands: newCommands });
    setEditingIndex(newCommands.length - 1);
  };

  const updateCommand = (index: number, field: keyof CustomCommandConfig, value: any) => {
    const newCommands = [...config.commands];
    newCommands[index] = { ...newCommands[index], [field]: value };
    onChange({ ...config, commands: newCommands });
  };

  const removeCommand = (index: number) => {
    const newCommands = [...config.commands];
    newCommands.splice(index, 1);
    onChange({ ...config, commands: newCommands });
    setEditingIndex(null);
  };

  // --- Alert Actions Logic ---
  const addAlertAction = () => {
    const newAlerts = [...config.alertActions, createDefaultAlertActionConfig()];
    onChange({ ...config, alertActions: newAlerts });
    setEditingIndex(newAlerts.length - 1);
  };

  const updateAlertAction = (index: number, field: keyof AlertActionConfig, value: any) => {
    const newAlerts = [...config.alertActions];
    newAlerts[index] = { ...newAlerts[index], [field]: value };
    onChange({ ...config, alertActions: newAlerts });
  };

  const removeAlertAction = (index: number) => {
    const newAlerts = [...config.alertActions];
    newAlerts.splice(index, 1);
    onChange({ ...config, alertActions: newAlerts });
    setEditingIndex(null);
  };

  // --- Auth/Account Logic ---
  const addAccount = () => {
    const newAccounts = [...config.accounts, createDefaultAccountConfig()];
    onChange({ ...config, accounts: newAccounts });
    setEditingIndex(newAccounts.length - 1);
  };

  const updateAccount = (index: number, field: keyof AccountConfig, value: any) => {
    const newAccounts = [...config.accounts];
    newAccounts[index] = { ...newAccounts[index], [field]: value };
    onChange({ ...config, accounts: newAccounts });
  };

  const removeAccount = (index: number) => {
    const newAccounts = [...config.accounts];
    newAccounts.splice(index, 1);
    onChange({ ...config, accounts: newAccounts });
    setEditingIndex(null);
  };

  const updateAccountField = (accountIndex: number, fieldIndex: number, prop: string, value: any) => {
    const newAccounts = [...config.accounts];
    const fields = [...newAccounts[accountIndex].fields];
    fields[fieldIndex] = { ...fields[fieldIndex], [prop]: value };
    newAccounts[accountIndex] = { ...newAccounts[accountIndex], fields };
    onChange({ ...config, accounts: newAccounts });
  };

  // --- REST Endpoints Logic ---
  const addRestEndpoint = () => {
    const newEndpoints = [...config.restEndpoints, createDefaultRestEndpointConfig()];
    onChange({ ...config, restEndpoints: newEndpoints });
    setEditingIndex(newEndpoints.length - 1);
  };

  const updateRestEndpoint = (index: number, field: keyof RestEndpointConfig, value: any) => {
    const newEndpoints = [...config.restEndpoints];
    newEndpoints[index] = { ...newEndpoints[index], [field]: value };
    onChange({ ...config, restEndpoints: newEndpoints });
  };

  const removeRestEndpoint = (index: number) => {
    const newEndpoints = [...config.restEndpoints];
    newEndpoints.splice(index, 1);
    onChange({ ...config, restEndpoints: newEndpoints });
    setEditingIndex(null);
  };

  const toggleRestMethod = (index: number, method: 'GET' | 'POST' | 'PUT' | 'DELETE') => {
    const endpoint = config.restEndpoints[index];
    const methods = new Set(endpoint.methods);
    if (methods.has(method)) {
      methods.delete(method);
    } else {
      methods.add(method);
    }
    updateRestEndpoint(index, 'methods', Array.from(methods));
  };

  return (
    <div className="components-step">
      <div className="tabs">
        <button
          className={`tab ${activeTab === 'inputs' ? 'active' : ''}`}
          onClick={() => { setActiveTab('inputs'); setEditingIndex(null); }}
        >
          Modular Inputs ({config.inputs.length})
        </button>
        <button
          className={`tab ${activeTab === 'commands' ? 'active' : ''}`}
          onClick={() => { setActiveTab('commands'); setEditingIndex(null); }}
        >
          Commands ({config.commands.length})
        </button>
        <button
          className={`tab ${activeTab === 'alerts' ? 'active' : ''}`}
          onClick={() => { setActiveTab('alerts'); setEditingIndex(null); }}
        >
          Alert Actions ({config.alertActions.length})
        </button>
        <button
          className={`tab ${activeTab === 'auth' ? 'active' : ''}`}
          onClick={() => { setActiveTab('auth'); setEditingIndex(null); }}
        >
          Auth ({config.accounts.length})
        </button>
        <button
          className={`tab ${activeTab === 'rest' ? 'active' : ''}`}
          onClick={() => { setActiveTab('rest'); setEditingIndex(null); }}
        >
          REST ({config.restEndpoints.length})
        </button>
      </div>

      <div className="tab-content">
        {/* --- Modular Inputs Tab --- */}
        {activeTab === 'inputs' && (
          <div className="inputs-config">
            <h3>Modular Inputs</h3>
            <p className="help-text">Define inputs to collect data from external sources.</p>

            <div className="component-list">
              {config.inputs.map((input, index) => (
                <div key={index} className={`component-item ${editingIndex === index ? 'editing' : ''}`}>
                  <div className="component-header" onClick={() => setEditingIndex(editingIndex === index ? null : index)}>
                    <span className="component-name">{input.title || '(Untitled Input)'}</span>
                    <span className="component-id">{input.name}</span>
                    <button className="btn-icon danger" onClick={(e) => { e.stopPropagation(); removeInput(index); }}>✕</button>
                  </div>

                  {editingIndex === index && (
                    <div className="component-form">
                      <div className="form-group">
                        <label>Input Name (Internal ID)</label>
                        <input
                          type="text"
                          value={input.name}
                          onChange={(e) => updateInput(index, 'name', e.target.value)}
                          placeholder="e.g. my_input"
                        />
                      </div>
                      <div className="form-group">
                        <label>Display Title</label>
                        <input
                          type="text"
                          value={input.title}
                          onChange={(e) => updateInput(index, 'title', e.target.value)}
                          placeholder="e.g. My Data Input"
                        />
                      </div>
                      <div className="form-group">
                        <label>Description</label>
                        <input
                          type="text"
                          value={input.description || ''}
                          onChange={(e) => updateInput(index, 'description', e.target.value)}
                          placeholder="Description shown in UI"
                        />
                      </div>

                      <EntityBuilder
                        entities={input.entity}
                        onChange={(entities) => updateInput(index, 'entity', entities)}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>

            <button className="btn btn-primary" onClick={addInput}>+ Add Modular Input</button>
          </div>
        )}

        {/* --- Custom Commands Tab --- */}
        {activeTab === 'commands' && (
          <div className="commands-config">
            <h3>Custom Commands</h3>
            <p className="help-text">Define custom SPL commands to process data.</p>

            <div className="component-list">
              {config.commands.map((cmd, index) => (
                <div key={index} className={`component-item ${editingIndex === index ? 'editing' : ''}`}>
                  <div className="component-header" onClick={() => setEditingIndex(editingIndex === index ? null : index)}>
                    <span className="component-name">{cmd.name || '(Untitled Command)'}</span>
                    <span className="component-id">{cmd.filename}</span>
                    <button className="btn-icon danger" onClick={(e) => { e.stopPropagation(); removeCommand(index); }}>✕</button>
                  </div>

                  {editingIndex === index && (
                    <div className="component-form">
                      <div className="form-row">
                        <div className="form-group half">
                          <label>Command Name</label>
                          <input
                            type="text"
                            value={cmd.name}
                            onChange={(e) => updateCommand(index, 'name', e.target.value)}
                            placeholder="e.g. mycommand"
                          />
                        </div>
                        <div className="form-group half">
                          <label>Filename (.py)</label>
                          <input
                            type="text"
                            value={cmd.filename}
                            onChange={(e) => updateCommand(index, 'filename', e.target.value)}
                            placeholder="e.g. my_command.py"
                          />
                        </div>
                      </div>

                      <div className="form-group">
                        <label>Command Type</label>
                        <select
                          value={cmd.type}
                          onChange={(e) => updateCommand(index, 'type', e.target.value)}
                        >
                          {COMMAND_TYPES.map(t => (
                            <option key={t.type} value={t.type}>{t.label} - {t.description}</option>
                          ))}
                        </select>
                      </div>

                      <div className="checkbox-grid">
                        <label>
                          <input
                            type="checkbox"
                            checked={cmd.chunked}
                            onChange={(e) => updateCommand(index, 'chunked', e.target.checked)}
                          /> Chunked Protocol
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={cmd.passauth}
                            onChange={(e) => updateCommand(index, 'passauth', e.target.checked)}
                          /> Pass Auth
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={cmd.supports_multivalues}
                            onChange={(e) => updateCommand(index, 'supports_multivalues', e.target.checked)}
                          /> Multi-values
                        </label>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <button className="btn btn-primary" onClick={addCommand}>+ Add Custom Command</button>
          </div>
        )}

        {/* --- Alert Actions Tab --- */}
        {activeTab === 'alerts' && (
          <div className="alerts-config">
            <h3>Alert Actions</h3>
            <p className="help-text">Define custom actions that can be triggered by alerts.</p>

            <div className="component-list">
              {config.alertActions.map((alert, index) => (
                <div key={index} className={`component-item ${editingIndex === index ? 'editing' : ''}`}>
                  <div className="component-header" onClick={() => setEditingIndex(editingIndex === index ? null : index)}>
                    <span className="component-name">{alert.label || '(Untitled Alert)'}</span>
                    <span className="component-id">{alert.name}</span>
                    <button className="btn-icon danger" onClick={(e) => { e.stopPropagation(); removeAlertAction(index); }}>✕</button>
                  </div>

                  {editingIndex === index && (
                    <div className="component-form">
                      <div className="form-group">
                        <label>Alert Action Name</label>
                        <input
                          type="text"
                          value={alert.name}
                          onChange={(e) => updateAlertAction(index, 'name', e.target.value)}
                          placeholder="e.g. send_to_service"
                        />
                      </div>
                      <div className="form-group">
                        <label>Display Label</label>
                        <input
                          type="text"
                          value={alert.label}
                          onChange={(e) => updateAlertAction(index, 'label', e.target.value)}
                          placeholder="e.g. Send to Service"
                        />
                      </div>
                      <div className="form-group">
                        <label>Description</label>
                        <input
                          type="text"
                          value={alert.description || ''}
                          onChange={(e) => updateAlertAction(index, 'description', e.target.value)}
                        />
                      </div>

                      <EntityBuilder
                        entities={alert.entity}
                        onChange={(entities) => updateAlertAction(index, 'entity', entities)}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>

            <button className="btn btn-primary" onClick={addAlertAction}>+ Add Alert Action</button>
          </div>
        )}

        {/* --- Authentication Tab --- */}
        {activeTab === 'auth' && (
          <div className="auth-config">
            <h3>Authentication & Accounts</h3>
            <p className="help-text">Define how users configure credentials for your app.</p>

            <div className="component-list">
              {config.accounts.map((account, index) => (
                <div key={index} className={`component-item ${editingIndex === index ? 'editing' : ''}`}>
                  <div className="component-header" onClick={() => setEditingIndex(editingIndex === index ? null : index)}>
                    <span className="component-name">{account.name || 'Global Account'}</span>
                    <span className="component-id">{account.authType}</span>
                    <button className="btn-icon danger" onClick={(e) => { e.stopPropagation(); removeAccount(index); }}>✕</button>
                  </div>

                  {editingIndex === index && (
                    <div className="component-form">
                      <div className="form-group">
                        <label>Config Name</label>
                        <input
                          type="text"
                          value={account.name}
                          onChange={(e) => updateAccount(index, 'name', e.target.value)}
                          placeholder="e.g. account"
                        />
                      </div>

                      <div className="form-group">
                        <label>Authentication Type</label>
                        <select
                          value={account.authType}
                          onChange={(e) => updateAccount(index, 'authType', e.target.value as AuthType)}
                        >
                          <option value="basic">Basic (Username/Password)</option>
                          <option value="oauth">OAuth 2.0</option>
                          <option value="apikey">API Key</option>
                        </select>
                      </div>

                      {/* We show fields but they are mostly fixed for basic auth, customizable for API key */}
                      <div className="fields-preview">
                        <h4>Configuration Fields</h4>
                        {account.fields.map((field, fIndex) => (
                          <div key={fIndex} className="field-row">
                            <input
                              type="text"
                              value={field.label}
                              onChange={(e) => updateAccountField(index, fIndex, 'label', e.target.value)}
                              placeholder="Label"
                            />
                            <select
                              value={field.type}
                              onChange={(e) => updateAccountField(index, fIndex, 'type', e.target.value as EntityType)}
                            >
                              {ENTITY_TYPES.map(t => <option key={t.type} value={t.type}>{t.label}</option>)}
                            </select>
                            <label className="checkbox-inline">
                              <input
                                type="checkbox"
                                checked={field.required}
                                onChange={(e) => updateAccountField(index, fIndex, 'required', e.target.checked)}
                              /> Req
                            </label>
                          </div>
                        ))}
                      </div>

                      {account.authType === 'oauth' && (
                        <div className="oauth-config">
                          <h4>OAuth Configuration</h4>
                          <div className="form-group">
                            <label>Redirect URI</label>
                            <input
                              type="text"
                              value={account.oauth?.redirectUri || ''}
                              onChange={(e) => updateAccount(index, 'oauth', { ...account.oauth, redirectUri: e.target.value })}
                            />
                          </div>
                          {/* Add other OAuth fields */}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <button className="btn btn-primary" onClick={addAccount}>+ Add Account Config</button>
          </div>
        )}

        {/* --- REST Endpoints Tab --- */}
        {activeTab === 'rest' && (
          <div className="rest-config">
            <h3>Custom REST Endpoints</h3>
            <p className="help-text">Define custom API endpoints handled by Python scripts.</p>

            <div className="component-list">
              {config.restEndpoints.map((endpoint, index) => (
                <div key={index} className={`component-item ${editingIndex === index ? 'editing' : ''}`}>
                  <div className="component-header" onClick={() => setEditingIndex(editingIndex === index ? null : index)}>
                    <span className="component-name">{endpoint.name || '(Untitled Endpoint)'}</span>
                    <span className="component-id">{endpoint.handlerClass}</span>
                    <button className="btn-icon danger" onClick={(e) => { e.stopPropagation(); removeRestEndpoint(index); }}>✕</button>
                  </div>

                  {editingIndex === index && (
                    <div className="component-form">
                      <div className="form-row">
                        <div className="form-group half">
                          <label>Endpoint Name</label>
                          <input
                            type="text"
                            value={endpoint.name}
                            onChange={(e) => updateRestEndpoint(index, 'name', e.target.value)}
                            placeholder="e.g. my_endpoint"
                          />
                        </div>
                        <div className="form-group half">
                          <label>Handler Class</label>
                          <input
                            type="text"
                            value={endpoint.handlerClass}
                            onChange={(e) => updateRestEndpoint(index, 'handlerClass', e.target.value)}
                            placeholder="e.g. MyHandler"
                          />
                        </div>
                      </div>

                      <div className="form-group">
                        <label>Supported Methods</label>
                        <div className="methods-select">
                          {(['GET', 'POST', 'PUT', 'DELETE'] as const).map(method => (
                            <label key={method} className={`method-chip ${endpoint.methods.includes(method) ? 'active' : ''}`}>
                              <input
                                type="checkbox"
                                checked={endpoint.methods.includes(method)}
                                onChange={() => toggleRestMethod(index, method)}
                                style={{ display: 'none' }}
                              />
                              {method}
                            </label>
                          ))}
                        </div>
                      </div>

                      <div className="form-group">
                        <label>
                          <input
                            type="checkbox"
                            checked={endpoint.requiresAuth}
                            onChange={(e) => updateRestEndpoint(index, 'requiresAuth', e.target.checked)}
                          /> Require Authentication
                        </label>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <button className="btn btn-primary" onClick={addRestEndpoint}>+ Add REST Endpoint</button>
          </div>
        )}
      </div>

      <style>{`
        .components-step {
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }
        .tabs {
          display: flex;
          gap: 0.5rem;
          border-bottom: 1px solid var(--border-color);
          padding-bottom: 0.5rem;
          overflow-x: auto;
        }
        .tab {
          background: none;
          border: none;
          padding: 0.5rem 1rem;
          color: var(--text-secondary);
          cursor: pointer;
          border-radius: 4px;
          white-space: nowrap;
        }
        .tab.active {
          background-color: var(--splunk-green);
          color: white;
        }
        .component-list {
          margin-bottom: 1rem;
        }
        .component-item {
          background-color: var(--splunk-gray);
          border: 1px solid var(--border-color);
          margin-bottom: 0.5rem;
          border-radius: 4px;
        }
        .component-item.editing {
          border-color: var(--splunk-green);
        }
        .component-header {
          padding: 1rem;
          display: flex;
          align-items: center;
          cursor: pointer;
        }
        .component-name {
          font-weight: bold;
          margin-right: 1rem;
        }
        .component-id {
          color: var(--text-secondary);
          font-family: monospace;
          flex: 1;
        }
        .component-form {
          padding: 1rem;
          border-top: 1px solid var(--border-color);
          background-color: rgba(0,0,0,0.1);
        }
        .checkbox-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 0.5rem;
          margin-top: 1rem;
        }
        .methods-select {
          display: flex;
          gap: 0.5rem;
        }
        .method-chip {
          padding: 0.25rem 0.75rem;
          border: 1px solid var(--border-color);
          border-radius: 1rem;
          cursor: pointer;
          user-select: none;
        }
        .method-chip.active {
          background-color: var(--splunk-green);
          border-color: var(--splunk-green);
          color: white;
        }
        .field-row {
          display: flex;
          gap: 0.5rem;
          margin-bottom: 0.5rem;
          align-items: center;
        }
        .field-row input[type="text"] {
          flex: 1;
        }
        .checkbox-inline {
          display: flex;
          align-items: center;
          gap: 0.25rem;
          white-space: nowrap;
        }
      `}</style>
    </div>
  );
}