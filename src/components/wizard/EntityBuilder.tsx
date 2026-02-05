import { useState } from 'react';
import type { EntityField, EntityType, ValidatorType } from '../../types/components';
import { ENTITY_TYPES, VALIDATOR_TYPES, createDefaultEntityField } from '../../types/components';

interface EntityBuilderProps {
  entities: EntityField[];
  onChange: (entities: EntityField[]) => void;
}

export function EntityBuilder({ entities, onChange }: EntityBuilderProps) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  const handleAdd = () => {
    onChange([...entities, createDefaultEntityField()]);
    setEditingIndex(entities.length);
  };

  const handleRemove = (index: number) => {
    const newEntities = [...entities];
    newEntities.splice(index, 1);
    onChange(newEntities);
    setEditingIndex(null);
  };

  const updateEntity = (index: number, field: string, value: any) => {
    const newEntities = [...entities];
    newEntities[index] = { ...newEntities[index], [field]: value };
    onChange(newEntities);
  };

  const addValidator = (entityIndex: number) => {
    const entity = entities[entityIndex];
    const validators = entity.validators || [];
    updateEntity(entityIndex, 'validators', [
      ...validators,
      { type: 'string' as ValidatorType }
    ]);
  };

  const updateValidator = (entityIndex: number, validatorIndex: number, field: string, value: any) => {
    const entity = entities[entityIndex];
    const validators = [...(entity.validators || [])];
    validators[validatorIndex] = { ...validators[validatorIndex], [field]: value };
    updateEntity(entityIndex, 'validators', validators);
  };

  const removeValidator = (entityIndex: number, validatorIndex: number) => {
    const entity = entities[entityIndex];
    const validators = [...(entity.validators || [])];
    validators.splice(validatorIndex, 1);
    updateEntity(entityIndex, 'validators', validators);
  };

  return (
    <div className="entity-builder">
      <h4>Configuration Fields</h4>
      <p className="help-text">Define the fields that users will configure in Splunk Manager.</p>

      <div className="entity-list">
        {entities.map((entity, index) => (
          <div key={index} className={`entity-item ${editingIndex === index ? 'editing' : ''}`}>
            <div className="entity-header" onClick={() => setEditingIndex(editingIndex === index ? null : index)}>
              <span className="entity-label">{entity.label || '(Untitled Field)'}</span>
              <span className="entity-type-badge">{entity.type}</span>
              <button
                className="btn-icon danger"
                onClick={(e) => { e.stopPropagation(); handleRemove(index); }}
              >
                ✕
              </button>
            </div>

            {editingIndex === index && (
              <div className="entity-form">
                <div className="form-row">
                  <div className="form-group half">
                    <label>Field Name (Internal)</label>
                    <input
                      type="text"
                      value={entity.field}
                      onChange={(e) => updateEntity(index, 'field', e.target.value)}
                      placeholder="e.g. api_key"
                    />
                  </div>
                  <div className="form-group half">
                    <label>Display Label</label>
                    <input
                      type="text"
                      value={entity.label}
                      onChange={(e) => updateEntity(index, 'label', e.target.value)}
                      placeholder="e.g. API Key"
                    />
                  </div>
                </div>

                <div className="form-row">
                  <div className="form-group half">
                    <label>Type</label>
                    <select
                      value={entity.type}
                      onChange={(e) => updateEntity(index, 'type', e.target.value as EntityType)}
                    >
                      {ENTITY_TYPES.map(t => (
                        <option key={t.type} value={t.type}>{t.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group half checkbox-wrapper">
                    <label>
                      <input
                        type="checkbox"
                        checked={entity.required}
                        onChange={(e) => updateEntity(index, 'required', e.target.checked)}
                      />
                      Required Field
                    </label>
                  </div>
                </div>

                <div className="form-group">
                  <label>Default Value</label>
                  <input
                    type="text"
                    value={String(entity.defaultValue || '')}
                    onChange={(e) => updateEntity(index, 'defaultValue', e.target.value)}
                  />
                </div>

                <div className="form-group">
                  <label>Help Text</label>
                  <input
                    type="text"
                    value={entity.help || ''}
                    onChange={(e) => updateEntity(index, 'help', e.target.value)}
                    placeholder="Instructions shown to the user"
                  />
                </div>

                <div className="validators-section">
                  <div className="section-header">
                    <label>Validators</label>
                    <button className="btn-small" onClick={() => addValidator(index)}>+ Add Validator</button>
                  </div>

                  {entity.validators?.map((validator, vIndex) => (
                    <div key={vIndex} className="validator-item">
                      <select
                        value={validator.type}
                        onChange={(e) => updateValidator(index, vIndex, 'type', e.target.value)}
                      >
                        {VALIDATOR_TYPES.map(t => (
                          <option key={t.type} value={t.type}>{t.label}</option>
                        ))}
                      </select>

                      {validator.type === 'string' && (
                        <>
                          <input
                            type="number"
                            placeholder="Min Len"
                            value={validator.minLength || ''}
                            onChange={(e) => updateValidator(index, vIndex, 'minLength', parseInt(e.target.value))}
                            className="short-input"
                          />
                          <input
                            type="number"
                            placeholder="Max Len"
                            value={validator.maxLength || ''}
                            onChange={(e) => updateValidator(index, vIndex, 'maxLength', parseInt(e.target.value))}
                            className="short-input"
                          />
                        </>
                      )}

                      {validator.type === 'regex' && (
                        <input
                          type="text"
                          placeholder="Pattern"
                          value={validator.pattern || ''}
                          onChange={(e) => updateValidator(index, vIndex, 'pattern', e.target.value)}
                        />
                      )}

                      <input
                        type="text"
                        placeholder="Error Message"
                        value={validator.errorMsg || ''}
                        onChange={(e) => updateValidator(index, vIndex, 'errorMsg', e.target.value)}
                        className="error-msg-input"
                      />

                      <button className="btn-icon danger" onClick={() => removeValidator(index, vIndex)}>✕</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <button className="btn btn-secondary full-width" onClick={handleAdd}>
        + Add Field
      </button>

      <style>{`
        .entity-builder {
          background-color: rgba(255,255,255,0.05);
          padding: 1rem;
          border-radius: 4px;
          margin-top: 1rem;
        }
        .entity-builder h4 {
          margin-bottom: 0.5rem;
          color: var(--splunk-green);
        }
        .entity-list {
          margin-bottom: 1rem;
        }
        .entity-item {
          background-color: var(--splunk-dark);
          border: 1px solid var(--border-color);
          margin-bottom: 0.5rem;
          border-radius: 4px;
        }
        .entity-item.editing {
          border-color: var(--splunk-green);
        }
        .entity-header {
          padding: 0.75rem;
          display: flex;
          align-items: center;
          cursor: pointer;
        }
        .entity-label {
          font-weight: bold;
          flex: 1;
        }
        .entity-type-badge {
          background-color: rgba(255,255,255,0.1);
          padding: 2px 6px;
          border-radius: 4px;
          font-size: 0.75rem;
          margin-right: 0.5rem;
        }
        .entity-form {
          padding: 1rem;
          border-top: 1px solid var(--border-color);
          background-color: rgba(0,0,0,0.2);
        }
        .form-row {
          display: flex;
          gap: 1rem;
          margin-bottom: 1rem;
        }
        .half {
          flex: 1;
        }
        .checkbox-wrapper {
          display: flex;
          align-items: flex-end;
          padding-bottom: 0.75rem;
        }
        .btn-icon {
          background: none;
          border: none;
          color: var(--text-secondary);
          cursor: pointer;
          font-size: 1rem;
        }
        .btn-icon:hover {
          color: var(--text-primary);
        }
        .btn-icon.danger:hover {
          color: #D32F2F;
        }
        .full-width {
          width: 100%;
        }
        .validators-section {
          margin-top: 1rem;
          border-top: 1px solid rgba(255,255,255,0.1);
          padding-top: 1rem;
        }
        .section-header {
          display: flex;
          justify-content: space-between;
          margin-bottom: 0.5rem;
        }
        .btn-small {
          background: none;
          border: 1px solid var(--splunk-green);
          color: var(--splunk-green);
          border-radius: 4px;
          padding: 2px 8px;
          font-size: 0.75rem;
          cursor: pointer;
        }
        .validator-item {
          display: flex;
          gap: 0.5rem;
          margin-bottom: 0.5rem;
        }
        .short-input {
          width: 80px;
        }
        .error-msg-input {
          flex: 1;
        }
      `}</style>
    </div>
  );
}
