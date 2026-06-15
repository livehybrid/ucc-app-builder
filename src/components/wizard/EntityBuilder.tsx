import { useState } from 'react';
import styled from 'styled-components';
import Button from '@splunk/react-ui/Button';
import ControlGroup from '@splunk/react-ui/ControlGroup';
import Text from '@splunk/react-ui/Text';
import Select from '@splunk/react-ui/Select';
import Switch from '@splunk/react-ui/Switch';
import Number from '@splunk/react-ui/Number';
import Heading from '@splunk/react-ui/Heading';
import Badge from '@splunk/react-ui/Badge';
import CollapsiblePanel from '@splunk/react-ui/CollapsiblePanel';
import ColumnLayout from '@splunk/react-ui/ColumnLayout';
import { variables } from '@splunk/themes';
import type { EntityField, EntityType, ValidatorType } from '../../types/components';
import { ENTITY_TYPES, VALIDATOR_TYPES, createDefaultEntityField } from '../../types/components';
import Cross from '@splunk/react-icons/Cross';

interface EntityBuilderProps {
  entities: EntityField[];
  onChange: (entities: EntityField[]) => void;
}

const EntityContainer = styled.div`
  background: rgba(255, 255, 255, 0.03);
  padding: 16px;
  border-radius: 6px;
  margin-top: 16px;
  border: 1px solid ${variables.borderColor};
`;

const EntityItem = styled.div`
  margin-bottom: 8px;
`;

const EntityHeaderRow = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`;

const EntityLabel = styled.span`
  font-weight: 600;
  flex: 1;
`;

const ValidatorRow = styled.div`
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
  align-items: flex-end;
`;

export function EntityBuilder({ entities, onChange }: EntityBuilderProps) {
  const [openPanels, setOpenPanels] = useState<Set<number>>(new Set());

  const togglePanel = (index: number) => {
    setOpenPanels((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const handleAdd = () => {
    onChange([...entities, createDefaultEntityField()]);
    setOpenPanels((prev) => new Set([...prev, entities.length]));
  };

  const handleRemove = (index: number) => {
    const newEntities = [...entities];
    newEntities.splice(index, 1);
    onChange(newEntities);
    setOpenPanels((prev) => {
      const next = new Set<number>();
      prev.forEach((i) => {
        if (i < index) next.add(i);
        else if (i > index) next.add(i - 1);
      });
      return next;
    });
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateEntity = (index: number, field: string, value: any) => {
    const newEntities = [...entities];
    newEntities[index] = { ...newEntities[index], [field]: value };
    onChange(newEntities);
  };

  const addValidator = (entityIndex: number) => {
    const entity = entities[entityIndex];
    const validators = entity.validators || [];
    updateEntity(entityIndex, 'validators', [...validators, { type: 'string' as ValidatorType }]);
  };

  const updateValidator = (
    entityIndex: number,
    validatorIndex: number,
    field: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    value: any
  ) => {
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
    <EntityContainer>
      <Heading level={4} style={{ color: '#65A637', marginBottom: 8 }}>
        Configuration Fields
      </Heading>
      <p style={{ color: '#9b9ea3', fontSize: '0.875rem', marginBottom: 16 }}>
        Define the fields that users will configure in Splunk Manager.
      </p>

      {entities.map((entity, index) => (
        <EntityItem key={index}>
          <CollapsiblePanel
            title={
              <EntityHeaderRow>
                <EntityLabel>{entity.label || '(Untitled Field)'}</EntityLabel>
                <Badge label={entity.type} />
              </EntityHeaderRow>
            }
            open={openPanels.has(index)}
            onChange={() => togglePanel(index)}
            actions={
              <Button
                appearance="destructive"
                icon={<Cross />}
                onClick={(e: React.MouseEvent) => {
                  e.stopPropagation();
                  handleRemove(index);
                }}
              />
            }
          >
            <div style={{ padding: '16px 0' }}>
              <ColumnLayout>
                <ColumnLayout.Row>
                  <ColumnLayout.Column span={6}>
                    <ControlGroup label="Field Name (Internal)" labelPosition="top">
                      <Text
                        value={entity.field}
                        onChange={(_e: unknown, { value }: { value: string }) =>
                          updateEntity(index, 'field', value)
                        }
                        placeholder="e.g. api_key"
                      />
                    </ControlGroup>
                  </ColumnLayout.Column>
                  <ColumnLayout.Column span={6}>
                    <ControlGroup label="Display Label" labelPosition="top">
                      <Text
                        value={entity.label}
                        onChange={(_e: unknown, { value }: { value: string }) =>
                          updateEntity(index, 'label', value)
                        }
                        placeholder="e.g. API Key"
                      />
                    </ControlGroup>
                  </ColumnLayout.Column>
                </ColumnLayout.Row>

                <ColumnLayout.Row>
                  <ColumnLayout.Column span={6}>
                    <ControlGroup label="Type" labelPosition="top">
                      <Select
                        value={entity.type}
                        onChange={(_e: unknown, { value }: { value: string | number | boolean }) =>
                          updateEntity(index, 'type', String(value) as EntityType)
                        }
                      >
                        {ENTITY_TYPES.map((t) => (
                          <Select.Option key={t.type} label={t.label} value={t.type} />
                        ))}
                      </Select>
                    </ControlGroup>
                  </ColumnLayout.Column>
                  <ColumnLayout.Column span={6}>
                    <ControlGroup label="Required" labelPosition="top">
                      <Switch
                        selected={entity.required}
                        onClick={() => updateEntity(index, 'required', !entity.required)}
                        appearance="toggle"
                      >
                        {entity.required ? 'Yes' : 'No'}
                      </Switch>
                    </ControlGroup>
                  </ColumnLayout.Column>
                </ColumnLayout.Row>
              </ColumnLayout>

              <ControlGroup label="Default Value" labelPosition="top">
                <Text
                  value={String(entity.defaultValue || '')}
                  onChange={(_e: unknown, { value }: { value: string }) =>
                    updateEntity(index, 'defaultValue', value)
                  }
                />
              </ControlGroup>

              <ControlGroup label="Help Text" labelPosition="top">
                <Text
                  value={entity.help || ''}
                  onChange={(_e: unknown, { value }: { value: string }) =>
                    updateEntity(index, 'help', value)
                  }
                  placeholder="Instructions shown to the user"
                />
              </ControlGroup>

              {/* Validators */}
              <div
                style={{
                  marginTop: 16,
                  borderTop: `1px solid ${variables.borderColor}`,
                  paddingTop: 16,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <Heading level={5}>Validators</Heading>
                  <Button
                    appearance="default"
                    onClick={() => addValidator(index)}
                    label="+ Add Validator"
                  />
                </div>

                {entity.validators?.map((validator, vIndex) => (
                  <ValidatorRow key={vIndex}>
                    <Select
                      value={validator.type}
                      onChange={(_e: unknown, { value }: { value: string | number | boolean }) =>
                        updateValidator(index, vIndex, 'type', String(value))
                      }
                      style={{ width: 140 }}
                    >
                      {VALIDATOR_TYPES.map((t) => (
                        <Select.Option key={t.type} label={t.label} value={t.type} />
                      ))}
                    </Select>

                    {validator.type === 'string' && (
                      <>
                        <Number
                          value={validator.minLength ?? undefined}
                          onChange={(_e: unknown, { value }: { value?: number }) =>
                            updateValidator(index, vIndex, 'minLength', value)
                          }
                          style={{ width: 90 }}
                        />
                        <Number
                          value={validator.maxLength ?? undefined}
                          onChange={(_e: unknown, { value }: { value?: number }) =>
                            updateValidator(index, vIndex, 'maxLength', value)
                          }
                          style={{ width: 90 }}
                        />
                      </>
                    )}

                    {validator.type === 'regex' && (
                      <Text
                        placeholder="Pattern"
                        value={validator.pattern || ''}
                        onChange={(_e: unknown, { value }: { value: string }) =>
                          updateValidator(index, vIndex, 'pattern', value)
                        }
                        style={{ flex: 1 }}
                      />
                    )}

                    <Text
                      placeholder="Error Message"
                      value={validator.errorMsg || ''}
                      onChange={(_e: unknown, { value }: { value: string }) =>
                        updateValidator(index, vIndex, 'errorMsg', value)
                      }
                      style={{ flex: 1 }}
                    />

                    <Button
                      appearance="destructive"
                      icon={<Cross />}
                      onClick={() => removeValidator(index, vIndex)}
                    />
                  </ValidatorRow>
                ))}
              </div>
            </div>
          </CollapsiblePanel>
        </EntityItem>
      ))}

      <Button appearance="default" onClick={handleAdd} label="+ Add Field" inline={false} />
    </EntityContainer>
  );
}
