import { useState, useCallback } from 'react';
import styled from 'styled-components';
import Button from '@splunk/react-ui/Button';
import Heading from '@splunk/react-ui/Heading';
import Message from '@splunk/react-ui/Message';
import { variables } from '@splunk/themes';

interface PasteConfigPanelProps {
  onLoad: (configJson: string) => void;
  onCancel: () => void;
}

const PanelContainer = styled.div`
  max-width: 800px;
  margin: 32px auto;
  padding: 0 32px;
  width: 100%;
`;

const JsonTextarea = styled.textarea`
  width: 100%;
  min-height: 360px;
  font-family: 'Splunk Platform Mono', Inconsolata, Consolas, monospace;
  font-size: 0.8125rem;
  line-height: 1.5;
  padding: 12px;
  box-sizing: border-box;
  border: 1px solid ${variables.borderColor};
  border-radius: 4px;
  background: ${variables.backgroundColorSidebar};
  color: ${variables.contentColorDefault};
  resize: vertical;
  outline: none;

  &:focus {
    border-color: ${variables.borderColor};
    box-shadow: 0 0 0 2px rgba(0, 118, 211, 0.35);
  }
`;

const ButtonRow = styled.div`
  display: flex;
  gap: 12px;
  margin-top: 16px;
`;

const MetaPreview = styled.div`
  margin-top: 16px;
  padding: 12px 16px;
  background: ${variables.backgroundColorSidebar};
  border: 1px solid ${variables.borderColor};
  border-radius: 4px;
  font-size: 0.875rem;

  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 16px;
    margin: 0;
  }
  dt { color: ${variables.contentColorDefault}; font-weight: 600; opacity: 0.6; }
  dd { margin: 0; font-family: 'Splunk Platform Mono', monospace; }
`;

type ParsedMeta = { name: string; displayName: string; version: string } | null;

function tryParse(json: string): { meta: ParsedMeta; error: string | null } {
  if (!json.trim()) return { meta: null, error: null };
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) {
      return { meta: null, error: 'Must be a JSON object.' };
    }
    const meta = parsed?.meta;
    if (!meta?.name) {
      return { meta: null, error: 'Missing required field: meta.name' };
    }
    return {
      meta: {
        name: meta.name,
        displayName: meta.displayName ?? meta.name,
        version: meta.version ?? '1.0.0',
      },
      error: null,
    };
  } catch (e) {
    return { meta: null, error: `Invalid JSON: ${(e as Error).message}` };
  }
}

export function PasteConfigPanel({ onLoad, onCancel }: PasteConfigPanelProps) {
  const [json, setJson] = useState('');

  const { meta, error } = tryParse(json);

  const handleLoad = useCallback(() => {
    if (meta) onLoad(json);
  }, [json, meta, onLoad]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Allow Tab to insert spaces rather than navigate away
      if (e.key === 'Tab') {
        e.preventDefault();
        const el = e.currentTarget;
        const start = el.selectionStart;
        const end = el.selectionEnd;
        const next = json.slice(0, start) + '  ' + json.slice(end);
        setJson(next);
        requestAnimationFrame(() => {
          el.selectionStart = el.selectionEnd = start + 2;
        });
      }
    },
    [json],
  );

  return (
    <PanelContainer>
      <Heading level={1}>Start from globalConfig.json</Heading>
      <p style={{ color: '#9b9ea3', marginBottom: 24 }}>
        Paste an existing <code>globalConfig.json</code> to use as your starting point. The app
        file structure will be generated around it so you can continue editing with the AI
        assistant or download the source ZIP.
      </p>

      <JsonTextarea
        value={json}
        onChange={(e) => setJson(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={'{\n  "meta": {\n    "name": "my_app",\n    "displayName": "My App",\n    "restRoot": "my_app",\n    "version": "1.0.0"\n  },\n  "pages": { ... }\n}'}
        spellCheck={false}
      />

      {json.trim() && error && (
        <div style={{ marginTop: 12 }}>
          <Message type="error">{error}</Message>
        </div>
      )}

      {meta && (
        <MetaPreview>
          <strong>Detected</strong>
          <dl>
            <dt>App ID</dt>
            <dd>{meta.name}</dd>
            <dt>Display name</dt>
            <dd>{meta.displayName}</dd>
            <dt>Version</dt>
            <dd>{meta.version}</dd>
          </dl>
        </MetaPreview>
      )}

      <ButtonRow>
        <Button
          appearance="primary"
          label="Load Config"
          disabled={!meta}
          onClick={handleLoad}
        />
        <Button appearance="default" label="Cancel" onClick={onCancel} />
      </ButtonRow>
    </PanelContainer>
  );
}
