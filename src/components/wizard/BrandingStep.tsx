import { useState, useCallback } from 'react';
import styled from 'styled-components';
import ControlGroup from '@splunk/react-ui/ControlGroup';
import Text from '@splunk/react-ui/Text';
import Heading from '@splunk/react-ui/Heading';
import Message from '@splunk/react-ui/Message';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import File from '@splunk/react-ui/File';
import { variables } from '@splunk/themes';
import { generateIconSet, isValidImageFile } from '../../lib/imageUtils';
import type { WizardState, BrandingConfig } from '../../types';

interface BrandingStepProps {
  state: WizardState;
  onChange: (field: string, value: string | boolean | BrandingConfig) => void;
}

const NAV_COLOR_PRESETS = [
  { name: 'Splunk Green', color: '#65A637' },
  { name: 'Orange', color: '#F58220' },
  { name: 'Blue', color: '#0076D3' },
  { name: 'Purple', color: '#9C27B0' },
  { name: 'Red', color: '#D32F2F' },
];

const IconPreviewRow = styled.div`
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 16px;
`;

const IconPreview = styled.div`
  width: 72px;
  height: 72px;
  background: ${variables.backgroundColorDialog};
  border: 1px solid ${variables.borderColor};
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  overflow: hidden;
  flex-shrink: 0;

  img {
    max-width: 100%;
    max-height: 100%;
  }
`;

const SizeBadge = styled.span`
  display: inline-block;
  background: #65a637;
  color: white;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 0.75rem;
  margin-right: 6px;
`;

const ColorPickerRow = styled.div`
  display: flex;
  align-items: center;
  gap: 16px;
`;

const NativeColorInput = styled.input`
  width: 50px;
  height: 40px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  padding: 0;
`;

const ColorPresets = styled.div`
  display: flex;
  gap: 8px;
  margin-top: 8px;
`;

const ColorPreset = styled.button<{ $color: string; $active: boolean }>`
  width: 32px;
  height: 32px;
  border-radius: 6px;
  border: 2px solid ${(props) => (props.$active ? '#fff' : 'transparent')};
  cursor: pointer;
  background-color: ${(props) => props.$color};
  transition: border-color 0.15s;

  &:hover {
    border-color: rgba(255, 255, 255, 0.5);
  }
`;

const NavPreview = styled.div<{ $color: string }>`
  margin-top: 16px;
  padding: 10px 16px;
  border-radius: 6px;
  color: white;
  font-weight: bold;
  display: flex;
  align-items: center;
  background-color: ${(props) => props.$color};
`;

export function BrandingStep({ state, onChange }: BrandingStepProps) {
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [uploadedFilename, setUploadedFilename] = useState<string | null>(null);

  const handleRequestAdd: (files: globalThis.File[]) => void = useCallback(
    async (files) => {
      const file = files[0];
      if (!file) return;

      if (!isValidImageFile(file)) {
        setError('Please upload a valid image file (PNG, JPG, SVG)');
        return;
      }

      setUploadedFilename(file.name);
      setIsProcessing(true);
      setError(null);

      try {
        const reader = new FileReader();
        reader.onload = async (ev) => {
          const dataUrl = ev.target?.result as string;
          const icons = await generateIconSet(file);
          const processedIcons = {
            appIcon: icons['appIcon.png'],
            appIcon2x: icons['appIcon_2x.png'],
            appIconAlt: icons['appIconAlt.png'],
            appIconAlt2x: icons['appIconAlt_2x.png'],
          };

          onChange('branding', {
            ...state.branding,
            logoFile: file,
            logoDataUrl: dataUrl,
            processedIcons,
          });
          setIsProcessing(false);
        };
        reader.readAsDataURL(file);
      } catch {
        setError('Failed to process image');
        setIsProcessing(false);
      }
    },
    [onChange, state.branding]
  );

  const handleRequestRemove = useCallback(() => {
    setUploadedFilename(null);
    onChange('branding', {
      ...state.branding,
      logoFile: null,
      logoDataUrl: undefined,
      processedIcons: undefined,
    });
  }, [onChange, state.branding]);

  return (
    <div>
      <Heading level={2}>Branding</Heading>
      <p style={{ color: '#9b9ea3', marginBottom: 24 }}>
        Customize the look of your app in Splunk.
      </p>

      <ControlGroup
        label="App Icon"
        labelPosition="top"
        help="Upload a high-resolution square image. All required Splunk icon sizes will be generated automatically."
      >
        <File
          accept="image/png,image/jpeg,image/svg+xml,.png,.jpg,.jpeg,.svg"
          onRequestAdd={handleRequestAdd}
          onRequestRemove={handleRequestRemove}
          disabled={isProcessing}
          supportsMessage="Supports PNG, JPG, and SVG images"
        >
          {uploadedFilename && (
            <File.Item name={uploadedFilename} uploadPercentage={isProcessing ? 50 : undefined} />
          )}
        </File>

        {isProcessing && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
            <WaitSpinner />
            <span style={{ color: '#9b9ea3', fontSize: '0.85rem' }}>Generating icon sizes...</span>
          </div>
        )}

        {state.branding.logoDataUrl && !isProcessing && (
          <IconPreviewRow>
            <IconPreview>
              <img src={state.branding.logoDataUrl} alt="App Icon" />
            </IconPreview>
            <div>
              <div style={{ color: '#9b9ea3', fontSize: '0.85rem', marginBottom: 4 }}>
                Generated sizes:
              </div>
              <SizeBadge>36px</SizeBadge>
              <SizeBadge>72px</SizeBadge>
            </div>
          </IconPreviewRow>
        )}

        {error && (
          <div style={{ marginTop: 8 }}>
            <Message type="error">{error}</Message>
          </div>
        )}
      </ControlGroup>

      <ControlGroup label="Navigation Bar Color" labelPosition="top">
        <ColorPickerRow>
          <NativeColorInput
            type="color"
            value={state.branding.navBarColor}
            onChange={(e) =>
              onChange('branding', { ...state.branding, navBarColor: e.target.value })
            }
          />
          <Text
            value={state.branding.navBarColor}
            onChange={(_e: unknown, { value }: { value: string }) =>
              onChange('branding', { ...state.branding, navBarColor: value })
            }
            style={{ width: 120 }}
          />
        </ColorPickerRow>
        <ColorPresets>
          {NAV_COLOR_PRESETS.map((preset) => (
            <ColorPreset
              key={preset.color}
              $color={preset.color}
              $active={state.branding.navBarColor === preset.color}
              onClick={() => onChange('branding', { ...state.branding, navBarColor: preset.color })}
              title={preset.name}
            />
          ))}
        </ColorPresets>
      </ControlGroup>

      <ControlGroup label="Preview" labelPosition="top">
        <NavPreview $color={state.branding.navBarColor}>
          {state.branding.logoDataUrl && (
            <img
              src={state.branding.logoDataUrl}
              alt="Logo"
              style={{ height: 20, width: 20, marginRight: 10, objectFit: 'contain' }}
            />
          )}
          {state.metadata.displayName || state.metadata.name || 'Your App'}
        </NavPreview>
      </ControlGroup>
    </div>
  );
}
