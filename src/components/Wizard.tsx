import { WIZARD_STEPS } from '../types';
import type { WizardState } from '../types';
import { BrandingStep } from './wizard/BrandingStep';
import { ComponentsStep } from './wizard/ComponentsStep';
import { createGlobalConfig } from '../types/globalConfig';

interface WizardProps {
  state: WizardState;
  onChange: (state: WizardState) => void;
  onGenerate: () => void;
}

export function Wizard({ state, onChange, onGenerate }: WizardProps) {
  const currentStepId = WIZARD_STEPS[state.currentStep].id;

  const updateMetadata = (field: string, value: string) => {
    onChange({
      ...state,
      metadata: { ...state.metadata, [field]: value },
    });
  };

  const handleStepChange = (field: string, value: any) => {
    onChange({
      ...state,
      [field]: value
    });
  };

  const updateComponents = (config: any) => {
    onChange({
      ...state,
      components: config
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

  const isStepComplete = (stepIndex: number) => {
    if (stepIndex === 0) {
      return state.metadata.name.trim() !== '' && state.metadata.version.trim() !== '';
    }
    return stepIndex < state.currentStep;
  };

  return (
    <div className="wizard">
      <div className="wizard-steps">
        {WIZARD_STEPS.map((step, index) => (
          <button
            key={step.id}
            className={`wizard-step ${index === state.currentStep ? 'active' : ''} ${isStepComplete(index) ? 'completed' : ''}`}
            onClick={() => goToStep(index)}
          >
            {index + 1}. {step.label}
          </button>
        ))}
      </div>

      <div className="wizard-content">
        {currentStepId === 'details' && (
          <div>
            <h2>App Details</h2>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
              Enter the basic information for your Splunk app.
            </p>

            <div className="form-group">
              <label htmlFor="name">App Name *</label>
              <input
                id="name"
                type="text"
                value={state.metadata.name}
                onChange={(e) => updateMetadata('name', e.target.value)}
                placeholder="My Splunk App"
              />
            </div>

            <div className="form-group">
              <label htmlFor="displayName">Display Name</label>
              <input
                id="displayName"
                type="text"
                value={state.metadata.displayName}
                onChange={(e) => updateMetadata('displayName', e.target.value)}
                placeholder="My Splunk App (shown in Splunk UI)"
              />
            </div>

            <div className="form-group">
              <label htmlFor="description">Description</label>
              <textarea
                id="description"
                value={state.metadata.description}
                onChange={(e) => updateMetadata('description', e.target.value)}
                placeholder="A brief description of what your app does..."
              />
            </div>

            <div className="form-group">
              <label htmlFor="author">Author</label>
              <input
                id="author"
                type="text"
                value={state.metadata.author}
                onChange={(e) => updateMetadata('author', e.target.value)}
                placeholder="Your name or organization"
              />
            </div>

            <div className="form-group">
              <label htmlFor="version">Version *</label>
              <input
                id="version"
                type="text"
                value={state.metadata.version}
                onChange={(e) => updateMetadata('version', e.target.value)}
                placeholder="1.0.0"
              />
            </div>

            <div className="form-group">
              <label htmlFor="appId">App ID (internal)</label>
              <input
                id="appId"
                type="text"
                value={state.metadata.appId}
                onChange={(e) => updateMetadata('appId', e.target.value)}
                placeholder="my_splunk_app (auto-generated if empty)"
              />
            </div>
          </div>
        )}

        {currentStepId === 'branding' && (
          <BrandingStep state={state} onChange={handleStepChange} />
        )}

        {currentStepId === 'components' && (
          <ComponentsStep config={state.components} onChange={updateComponents} />
        )}

        {currentStepId === 'review' && (
          <div>
            <h2>Review & Generate</h2>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
              Review your configuration before generating the app.
            </p>

            <div className="review-section">
              <h3>App Details</h3>
              <div className="review-item">
                <span className="label">Name:</span>
                <span className="value">{state.metadata.name || '(not set)'}</span>
              </div>
              <div className="review-item">
                <span className="label">Display Name:</span>
                <span className="value">{state.metadata.displayName || state.metadata.name || '(not set)'}</span>
              </div>
              <div className="review-item">
                <span className="label">Version:</span>
                <span className="value">{state.metadata.version}</span>
              </div>
              <div className="review-item">
                <span className="label">Author:</span>
                <span className="value">{state.metadata.author || '(not set)'}</span>
              </div>
            </div>

            <div className="review-section">
              <h3>Components</h3>
              <div className="review-item">
                <span className="label">Modular Inputs:</span>
                <span className="value">{state.components.inputs.length}</span>
              </div>
              <div className="review-item">
                <span className="label">Custom Commands:</span>
                <span className="value">{state.components.commands.length}</span>
              </div>
              <div className="review-item">
                <span className="label">Alert Actions:</span>
                <span className="value">{state.components.alertActions.length}</span>
              </div>
              <div className="review-item">
                <span className="label">Auth Config:</span>
                <span className="value">{state.components.accounts.length} accounts</span>
              </div>
            </div>

            <div className="review-section">
              <h3>globalConfig.json Preview</h3>
              <pre className="code-preview">
                {JSON.stringify(
                  createGlobalConfig(
                    state.metadata.appId || state.metadata.name.toLowerCase().replace(/[^a-z0-9]/g, '_'),
                    state.metadata.displayName || state.metadata.name,
                    state.metadata.version,
                    state.components
                  ),
                  null,
                  2
                )}
              </pre>
            </div>
          </div>
        )}
      </div>

      <div className="wizard-actions">
        <button
          className="btn btn-secondary"
          onClick={() => goToStep(state.currentStep - 1)}
          disabled={state.currentStep === 0}
        >
          Previous
        </button>

        {state.currentStep < WIZARD_STEPS.length - 1 ? (
          <button
            className="btn btn-primary"
            onClick={() => goToStep(state.currentStep + 1)}
            disabled={!canProceed()}
          >
            Next
          </button>
        ) : (
          <button
            className="btn btn-primary"
            onClick={onGenerate}
            disabled={!state.metadata.name}
          >
            Generate App
          </button>
        )}
      </div>
    </div>
  );
}
