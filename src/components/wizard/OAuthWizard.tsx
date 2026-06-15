import { useState, useEffect } from 'react';
import styled from 'styled-components';
import Button from '@splunk/react-ui/Button';
import Text from '@splunk/react-ui/Text';
import Heading from '@splunk/react-ui/Heading';
import Message from '@splunk/react-ui/Message';
import Select from '@splunk/react-ui/Select';
import Modal from '@splunk/react-ui/Modal';
import { variables } from '@splunk/themes';

interface OAuthWizardProps {
  open: boolean;
  onClose: () => void;
  onSave: (config: OAuthConfiguration) => void;
  initialConfig?: OAuthConfiguration;
}

export interface OAuthConfiguration {
  authType: 'oauth2' | 'api_key' | 'basic';
  clientId?: string;
  clientSecret?: string;
  authUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
  redirectUri?: string;
  label?: string;
}

const WizardContainer = styled.div`
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
`;

const FormRow = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const StepIndicator = styled.div`
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
`;

const StepDot = styled.div<{ $active: boolean; $completed: boolean }>`
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background-color: ${(props) =>
    props.$active ? variables.brandColor : props.$completed ? variables.successColor : '#ccc'};
`;

export function OAuthWizard({ open, onClose, onSave, initialConfig }: OAuthWizardProps) {
  const [step, setStep] = useState(1);
  const [config, setConfig] = useState<OAuthConfiguration>({
    authType: 'oauth2',
    label: 'OAuth 2.0 Account',
    scopes: [],
    redirectUri: 'https://localhost:8000/en-US/app/my_app/oauth_callback',
  });

  useEffect(() => {
    if (initialConfig) {
      setConfig(initialConfig);
    }
  }, [initialConfig]);

  const handleNext = () => setStep((s) => s + 1);
  const handleBack = () => setStep((s) => s - 1);

  const isValidStep1 = config.label && config.authType;
  const isValidStep2 =
    config.authType === 'oauth2'
      ? config.clientId && config.clientSecret && config.authUrl && config.tokenUrl
      : true; // Basic/API Key are simpler

  return (
    <Modal open={open} onRequestClose={onClose} returnFocus={() => {}} style={{ width: '600px' }}>
      <Modal.Header title="Configure Authentication" />
      <Modal.Body>
        <WizardContainer>
          <StepIndicator>
            <StepDot $active={step === 1} $completed={step > 1} />
            <StepDot $active={step === 2} $completed={step > 2} />
            <StepDot $active={step === 3} $completed={step > 3} />
          </StepIndicator>

          {step === 1 && (
            <>
              <Heading level={3}>Select Authentication Type</Heading>
              <FormRow>
                <label>Account Label</label>
                <Text
                  value={config.label}
                  onChange={(_e, { value }) => setConfig({ ...config, label: value })}
                  placeholder="e.g. Production Account"
                />
              </FormRow>
              <FormRow>
                <label>Auth Method</label>
                <Select
                  value={config.authType}
                  onChange={(_e, { value }) =>
                    setConfig({ ...config, authType: value as OAuthConfiguration['authType'] })
                  }
                >
                  <Select.Option label="OAuth 2.0 (Authorization Code)" value="oauth2" />
                  <Select.Option label="API Key" value="api_key" />
                  <Select.Option label="Basic Auth (Username/Password)" value="basic" />
                </Select>
              </FormRow>
              <Message type="info">
                {config.authType === 'oauth2' &&
                  'Best for modern REST APIs. Handles token refresh automatically.'}
                {config.authType === 'api_key' && 'Simple key-based authentication.'}
                {config.authType === 'basic' && 'Legacy username/password authentication.'}
              </Message>
            </>
          )}

          {step === 2 && config.authType === 'oauth2' && (
            <>
              <Heading level={3}>OAuth Details</Heading>
              <FormRow>
                <label>Client ID Field Name</label>
                <Text
                  value={config.clientId || 'client_id'}
                  onChange={(_e, { value }) => setConfig({ ...config, clientId: value })}
                />
              </FormRow>
              <FormRow>
                <label>Client Secret Field Name</label>
                <Text
                  value={config.clientSecret || 'client_secret'}
                  onChange={(_e, { value }) => setConfig({ ...config, clientSecret: value })}
                />
              </FormRow>
              <FormRow>
                <label>Authorization URL</label>
                <Text
                  value={config.authUrl}
                  onChange={(_e, { value }) => setConfig({ ...config, authUrl: value })}
                  placeholder="https://api.example.com/oauth/authorize"
                />
              </FormRow>
              <FormRow>
                <label>Token URL</label>
                <Text
                  value={config.tokenUrl}
                  onChange={(_e, { value }) => setConfig({ ...config, tokenUrl: value })}
                  placeholder="https://api.example.com/oauth/token"
                />
              </FormRow>
              <FormRow>
                <label>Redirect URI (Callback)</label>
                <Text
                  value={config.redirectUri}
                  onChange={(_e, { value }) => setConfig({ ...config, redirectUri: value })}
                />
              </FormRow>
            </>
          )}

          {step === 3 && (
            <>
              <Heading level={3}>Preview Configuration</Heading>
              <Message type="success">Ready to generate configuration!</Message>
              <pre
                style={{
                  background: '#f0f0f0',
                  padding: '10px',
                  borderRadius: '4px',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {JSON.stringify(config, null, 2)}
              </pre>
              <Text>
                This will add fields to your Global Config and create necessary handler scripts.
              </Text>
            </>
          )}
        </WizardContainer>
      </Modal.Body>
      <Modal.Footer>
        <Button onClick={onClose} appearance="secondary" label="Cancel" />
        {step > 1 && <Button onClick={handleBack} label="Back" />}
        {step < 3 ? (
          <Button
            appearance="primary"
            onClick={handleNext}
            label="Next"
            disabled={step === 1 ? !isValidStep1 : !isValidStep2}
          />
        ) : (
          <Button appearance="primary" onClick={() => onSave(config)} label="Finish & Generate" />
        )}
      </Modal.Footer>
    </Modal>
  );
}
