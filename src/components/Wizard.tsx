import { useState, useCallback } from 'react';
import styled from 'styled-components';
import Button from '@splunk/react-ui/Button';
import ControlGroup from '@splunk/react-ui/ControlGroup';
import Text from '@splunk/react-ui/Text';
import TextArea from '@splunk/react-ui/TextArea';
import Select from '@splunk/react-ui/Select';
import Heading from '@splunk/react-ui/Heading';
import DefinitionList from '@splunk/react-ui/DefinitionList';
import { variables } from '@splunk/themes';
import { WIZARD_STEPS } from '../types';
import type { WizardState, BrandingConfig } from '../types';
import type { ComponentsConfig } from '../types/components';
import { BrandingStep } from './wizard/BrandingStep';
import { ComponentsStep } from './wizard/ComponentsStep';
import { createGlobalConfig } from '../types/globalConfig';

interface WizardProps {
  state: WizardState;
  onChange: (state: WizardState) => void;
  onGenerate: () => void;
}

const WizardContainer = styled.div`
  background: ${variables.backgroundColorDialog};
  border-radius: 12px;
  padding: 32px;
  max-width: 960px;
  margin: 32px auto;
  width: calc(100% - 64px);
  border: 1px solid ${variables.borderColor};
`;

/* Custom Step Indicator - replacing StepBar for better control */
const StepIndicatorContainer = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: center;
  gap: 0;
  margin-bottom: 8px;
`;

const StepItem = styled.div<{ $isActive: boolean; $isCompleted: boolean }>`
  display: flex;
  flex-direction: column;
  align-items: center;
  position: relative;
  flex: 1;
  max-width: 180px;

  &:not(:last-child)::after {
    content: '';
    position: absolute;
    top: 18px;
    left: calc(50% + 22px);
    width: calc(100% - 44px);
    height: 2px;
    background: ${(props) => (props.$isCompleted ? '#65A637' : variables.borderColor)};
  }
`;

const StepCircle = styled.div<{ $isActive: boolean; $isCompleted: boolean }>`
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 1rem;
  line-height: 1;
  transition: all 0.2s ease;
  flex-shrink: 0;

  ${(props) =>
    props.$isActive
      ? `
    background: linear-gradient(135deg, #65A637, #8BC34A);
    color: white;
    box-shadow: 0 4px 12px rgba(101, 166, 55, 0.3);
  `
      : props.$isCompleted
        ? `
    background: #65A637;
    color: white;
  `
        : `
    background: ${variables.backgroundColorPage};
    border: 2px solid ${variables.borderColor};
    color: #9b9ea3;
  `}
`;

const StepLabel = styled.span<{ $isActive: boolean }>`
  margin-top: 10px;
  font-size: 0.85rem;
  font-weight: ${(props) => (props.$isActive ? 600 : 400)};
  color: ${(props) => (props.$isActive ? '#65A637' : '#9b9ea3')};
  text-align: center;
  white-space: nowrap;
`;

const WizardContent = styled.div`
  margin-top: 24px;
`;

const WizardActions = styled.div`
  display: flex;
  justify-content: space-between;
  margin-top: 32px;
  padding-top: 16px;
  border-top: 1px solid ${variables.borderColor};
`;

const CodePreview = styled.pre`
  background: ${variables.backgroundColorPage};
  border: 1px solid ${variables.borderColor};
  border-radius: 4px;
  padding: 16px;
  overflow: auto;
  font-family: 'Splunk Platform Mono', Inconsolata, Consolas, monospace;
  font-size: 0.875rem;
  max-height: 300px;
`;

/** Common licenses for the wizard's License dropdown; picking one auto-fills the URI. */
const LICENSE_PRESETS: ReadonlyArray<{ name: string; uri: string }> = [
  { name: 'Apache-2.0', uri: 'https://www.apache.org/licenses/LICENSE-2.0' },
  { name: 'MIT', uri: 'https://opensource.org/licenses/MIT' },
  { name: 'BSD-3-Clause', uri: 'https://opensource.org/licenses/BSD-3-Clause' },
  { name: 'GPL-3.0', uri: 'https://www.gnu.org/licenses/gpl-3.0.html' },
  { name: 'MPL-2.0', uri: 'https://www.mozilla.org/en-US/MPL/2.0/' },
];
const CUSTOM_LICENSE = '__custom__';

export function Wizard({ state, onChange, onGenerate }: WizardProps) {
  const currentStepId = WIZARD_STEPS[state.currentStep].id;
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  // True when the user picked "Custom…" (or the imported app has a non-preset license).
  const [customLicense, setCustomLicense] = useState(
    () =>
      state.metadata.licenseName !== '' &&
      !LICENSE_PRESETS.some((p) => p.name === state.metadata.licenseName)
  );

  const markTouched = useCallback((field: string) => {
    setTouched((prev) => ({ ...prev, [field]: true }));
  }, []);

  const getFieldError = (field: string, value: string, required?: boolean): string | undefined => {
    if (!touched[field]) return undefined;
    if (required && !value.trim()) return 'This field is required';
    if (field === 'version' && value && !/^\d+\.\d+\.\d+/.test(value))
      return 'Must be a valid semantic version (e.g. 1.0.0)';
    if (field === 'appId' && value && !/^[a-z][a-z0-9_]*$/.test(value))
      return 'Must start with lowercase letter, only a-z, 0-9, and underscores';
    return undefined;
  };

  const updateMetadata = (field: string, value: string) => {
    onChange({
      ...state,
      metadata: { ...state.metadata, [field]: value },
    });
  };

  const handleStepChange = (field: string, value: string | boolean | BrandingConfig) => {
    onChange({
      ...state,
      [field]: value,
    });
  };

  const updateComponents = (config: ComponentsConfig) => {
    onChange({
      ...state,
      components: config,
    });
  };

  const goToStep = (step: number) => {
    onChange({ ...state, currentStep: step });
  };

  const canProceed = () => {
    if (currentStepId === 'details') {
      return state.metadata.name.trim() !== '' && state.metadata.version.trim() !== '';
    }
    return true;
  };

  return (
    <WizardContainer>
      <StepIndicatorContainer>
        {WIZARD_STEPS.map((step, index) => {
          const isActive = index === state.currentStep;
          const isCompleted = index < state.currentStep;
          return (
            <StepItem key={step.id} $isActive={isActive} $isCompleted={isCompleted}>
              <StepCircle $isActive={isActive} $isCompleted={isCompleted}>
                {index + 1}
              </StepCircle>
              <StepLabel $isActive={isActive}>{step.label}</StepLabel>
            </StepItem>
          );
        })}
      </StepIndicatorContainer>

      <WizardContent>
        {currentStepId === 'details' && (
          <div>
            <Heading level={2}>App Details</Heading>
            <p style={{ color: '#9b9ea3', marginBottom: 24 }}>
              Enter the basic information for your Splunk app.
            </p>

            <ControlGroup
              label="App Name"
              labelPosition="top"
              help="Required. Shown in the Splunk UI; also used to derive the App ID below."
              error={touched.name && getFieldError('name', state.metadata.name, true)}
            >
              <Text
                value={state.metadata.name}
                onChange={(_e: unknown, { value }: { value: string }) =>
                  // Single source of truth for the human-readable name: every
                  // consumer (app.conf label, manifest title, README, globalConfig
                  // meta) resolves `displayName || name`, so the separate Display
                  // Name field was redundant and has been consolidated away.
                  updateMetadata('name', value)
                }
                onBlur={() => markTouched('name')}
                error={!!getFieldError('name', state.metadata.name, true)}
                placeholder="My Splunk App"
              />
            </ControlGroup>

            <ControlGroup
              label="Description"
              labelPosition="top"
              help="A brief description of what your app does."
            >
              <TextArea
                value={state.metadata.description}
                onChange={(_e: unknown, { value }: { value: string }) =>
                  updateMetadata('description', value)
                }
                rowsMin={3}
              />
            </ControlGroup>

            <ControlGroup label="Author" labelPosition="top">
              <Text
                value={state.metadata.author}
                onChange={(_e: unknown, { value }: { value: string }) =>
                  updateMetadata('author', value)
                }
                placeholder="Your name or organization"
              />
            </ControlGroup>

            <ControlGroup label="Author Email" labelPosition="top" help="Required for UCC build.">
              <Text
                value={state.metadata.email}
                onChange={(_e: unknown, { value }: { value: string }) =>
                  updateMetadata('email', value)
                }
                placeholder="author@example.com"
              />
            </ControlGroup>

            <ControlGroup
              label="Version"
              labelPosition="top"
              help="Required. Semantic version number."
              error={touched.version && getFieldError('version', state.metadata.version, true)}
            >
              <Text
                value={state.metadata.version}
                onChange={(_e: unknown, { value }: { value: string }) =>
                  updateMetadata('version', value)
                }
                onBlur={() => markTouched('version')}
                error={!!getFieldError('version', state.metadata.version, true)}
                placeholder="1.0.0"
              />
            </ControlGroup>

            <ControlGroup
              label="App ID (internal)"
              labelPosition="top"
              help="Auto-generated from App Name if left empty."
              error={touched.appId && getFieldError('appId', state.metadata.appId)}
            >
              <Text
                value={state.metadata.appId}
                onChange={(_e: unknown, { value }: { value: string }) =>
                  updateMetadata('appId', value)
                }
                onBlur={() => markTouched('appId')}
                error={!!getFieldError('appId', state.metadata.appId)}
                placeholder="my_splunk_app (auto-generated if empty)"
              />
            </ControlGroup>

            <ControlGroup
              label="License"
              labelPosition="top"
              help="Required for UCC build. Picking a license auto-fills the URI below."
            >
              <Select
                value={customLicense ? CUSTOM_LICENSE : state.metadata.licenseName}
                onChange={(_e: unknown, { value }: { value: unknown }) => {
                  const selected = String(value);
                  if (selected === CUSTOM_LICENSE) {
                    setCustomLicense(true);
                    return;
                  }
                  setCustomLicense(false);
                  const preset = LICENSE_PRESETS.find((p) => p.name === selected);
                  updateMetadata('licenseName', selected);
                  if (preset?.uri) updateMetadata('licenseUri', preset.uri);
                }}
              >
                {LICENSE_PRESETS.map((p) => (
                  <Select.Option key={p.name} label={p.name} value={p.name} />
                ))}
                <Select.Option label="Custom…" value={CUSTOM_LICENSE} />
              </Select>
            </ControlGroup>

            {customLicense && (
              <ControlGroup label="Custom License Name" labelPosition="top">
                <Text
                  value={state.metadata.licenseName}
                  onChange={(_e: unknown, { value }: { value: string }) =>
                    updateMetadata('licenseName', value)
                  }
                  placeholder="My-Company-EULA"
                />
              </ControlGroup>
            )}

            <ControlGroup
              label="License URI"
              labelPosition="top"
              help="Required for UCC build. Auto-filled when a license is selected above."
            >
              <Text
                value={state.metadata.licenseUri}
                onChange={(_e: unknown, { value }: { value: string }) =>
                  updateMetadata('licenseUri', value)
                }
                placeholder="https://www.apache.org/licenses/LICENSE-2.0"
              />
            </ControlGroup>
          </div>
        )}

        {currentStepId === 'branding' && <BrandingStep state={state} onChange={handleStepChange} />}

        {currentStepId === 'components' && (
          <ComponentsStep config={state.components} onChange={updateComponents} />
        )}

        {currentStepId === 'review' && (
          <div>
            <Heading level={2}>Review &amp; Generate</Heading>
            <p style={{ color: '#9b9ea3', marginBottom: 24 }}>
              Review your configuration before generating the app.
            </p>

            <Heading level={3}>App Details</Heading>
            <DefinitionList>
              <DefinitionList.Term>Name</DefinitionList.Term>
              <DefinitionList.Description>
                {state.metadata.name || '(not set)'}
              </DefinitionList.Description>
              <DefinitionList.Term>App ID</DefinitionList.Term>
              <DefinitionList.Description>
                {state.metadata.appId ||
                  (state.metadata.name
                    ? state.metadata.name.toLowerCase().replace(/[^a-z0-9]/g, '_')
                    : '(not set)')}
              </DefinitionList.Description>
              <DefinitionList.Term>Version</DefinitionList.Term>
              <DefinitionList.Description>{state.metadata.version}</DefinitionList.Description>
              <DefinitionList.Term>Author</DefinitionList.Term>
              <DefinitionList.Description>
                {state.metadata.author || '(not set)'}
              </DefinitionList.Description>
            </DefinitionList>

            <Heading level={3} style={{ marginTop: 24 }}>
              Components
            </Heading>
            <DefinitionList>
              <DefinitionList.Term>Modular Inputs</DefinitionList.Term>
              <DefinitionList.Description>
                {state.components.inputs.length}
              </DefinitionList.Description>
              <DefinitionList.Term>Custom Commands</DefinitionList.Term>
              <DefinitionList.Description>
                {state.components.commands.length}
              </DefinitionList.Description>
              <DefinitionList.Term>Alert Actions</DefinitionList.Term>
              <DefinitionList.Description>
                {state.components.alertActions.length}
              </DefinitionList.Description>
              <DefinitionList.Term>Auth Config</DefinitionList.Term>
              <DefinitionList.Description>
                {state.components.accounts.length} accounts
              </DefinitionList.Description>
            </DefinitionList>

            <Heading level={3} style={{ marginTop: 24 }}>
              globalConfig.json Preview
            </Heading>
            <CodePreview>
              {JSON.stringify(
                createGlobalConfig(
                  state.metadata.appId ||
                    state.metadata.name.toLowerCase().replace(/[^a-z0-9]/g, '_'),
                  state.metadata.displayName || state.metadata.name,
                  state.metadata.version,
                  state.components
                ),
                null,
                2
              )}
            </CodePreview>
          </div>
        )}
      </WizardContent>

      <WizardActions>
        <Button
          appearance="default"
          onClick={() => goToStep(state.currentStep - 1)}
          disabled={state.currentStep === 0}
          label="Previous"
        />

        {state.currentStep < WIZARD_STEPS.length - 1 ? (
          <Button
            appearance="primary"
            onClick={() => goToStep(state.currentStep + 1)}
            disabled={!canProceed()}
            label="Next"
          />
        ) : (
          <Button
            appearance="primary"
            onClick={onGenerate}
            disabled={!state.metadata.name}
            label="Generate App"
          />
        )}
      </WizardActions>
    </WizardContainer>
  );
}
