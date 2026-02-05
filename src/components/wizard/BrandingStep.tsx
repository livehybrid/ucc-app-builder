import { useState, useCallback } from 'react';
import { generateIconSet, isValidImageFile } from '../../lib/imageUtils';
import type { WizardState } from '../../types';

interface BrandingStepProps {
  state: WizardState;
  onChange: (field: string, value: any) => void;
}

const NAV_COLOR_PRESETS = [
  { name: 'Splunk Green', color: '#65A637' },
  { name: 'Orange', color: '#F58220' },
  { name: 'Blue', color: '#0076D3' },
  { name: 'Purple', color: '#9C27B0' },
  { name: 'Red', color: '#D32F2F' },
];

export function BrandingStep({ state, onChange }: BrandingStepProps) {
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const handleLogoUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!isValidImageFile(file)) {
      setError('Please upload a valid image file (PNG, JPG, SVG)');
      return;
    }

    setIsProcessing(true);
    setError(null);

    try {
      // Create data URL for preview
      const reader = new FileReader();
      reader.onload = async (e) => {
        const dataUrl = e.target?.result as string;

        // Generate all icon sizes
        const icons = await generateIconSet(file);

        // Map to expected keys in BrandingConfig
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
          processedIcons
        });

        setIsProcessing(false);
      };
      reader.readAsDataURL(file);
    } catch (err) {
      setError('Failed to process image');
      setIsProcessing(false);
    }
  }, [onChange, state.branding]);

  return (
    <div>
      <h2>Branding</h2>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
        Customize the look of your app in Splunk.
      </p>

      <div className="form-group">
        <label>App Icon</label>
        <p className="help-text">Upload a high-resolution square image. We'll generate all required sizes for Splunk.</p>

        <div className="logo-upload-container">
          <div className="logo-preview">
            {state.branding.logoDataUrl ? (
              <img src={state.branding.logoDataUrl} alt="App Logo" />
            ) : (
              <div className="logo-placeholder">No Icon</div>
            )}
          </div>

          <div className="upload-controls">
            <input
              type="file"
              id="logo-upload"
              accept="image/*"
              onChange={handleLogoUpload}
              disabled={isProcessing}
              style={{ display: 'none' }}
            />
            <label htmlFor="logo-upload" className="btn btn-secondary">
              {isProcessing ? 'Processing...' : 'Upload Icon'}
            </label>
            {state.branding.logoDataUrl && (
              <div className="generated-previews">
                <span>Generated sizes:</span>
                <div className="mini-previews">
                  <div title="appIcon.png (36x36)">36px</div>
                  <div title="appIcon_2x.png (72x72)">72px</div>
                </div>
              </div>
            )}
          </div>
        </div>
        {error && <div className="error-text">{error}</div>}
      </div>

      <div className="form-group">
        <label>Navigation Bar Color</label>
        <div className="color-picker">
          <input
            type="color"
            value={state.branding.navBarColor}
            onChange={(e) => onChange('branding', { ...state.branding, navBarColor: e.target.value })}
          />
          <input
            type="text"
            value={state.branding.navBarColor}
            onChange={(e) => onChange('branding', { ...state.branding, navBarColor: e.target.value })}
            style={{ width: '120px' }}
          />
        </div>
        <div className="color-presets" style={{ marginTop: '0.5rem' }}>
          {NAV_COLOR_PRESETS.map((preset) => (
            <button
              key={preset.color}
              className={`color-preset ${state.branding.navBarColor === preset.color ? 'active' : ''}`}
              style={{ backgroundColor: preset.color }}
              onClick={() => onChange('branding', { ...state.branding, navBarColor: preset.color })}
              title={preset.name}
            />
          ))}
        </div>
      </div>

      <div className="form-group">
        <label>Preview</label>
        <div
          className="nav-preview"
          style={{ backgroundColor: state.branding.navBarColor }}
        >
          {state.branding.logoDataUrl && (
            <img
              src={state.branding.logoDataUrl}
              alt="Logo"
              style={{ height: '20px', width: '20px', marginRight: '10px', objectFit: 'contain' }}
            />
          )}
          {state.metadata.displayName || state.metadata.name || 'Your App'}
        </div>
      </div>

      <style>{`
        .logo-upload-container {
          display: flex;
          gap: 1.5rem;
          align-items: center;
          margin-bottom: 1rem;
          background-color: var(--splunk-dark);
          padding: 1rem;
          border-radius: 4px;
        }
        .logo-preview {
          width: 80px;
          height: 80px;
          background-color: var(--splunk-gray);
          border: 1px dashed var(--border-color);
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 4px;
          overflow: hidden;
        }
        .logo-preview img {
          max-width: 100%;
          max-height: 100%;
        }
        .logo-placeholder {
          color: var(--text-secondary);
          font-size: 0.75rem;
          text-align: center;
        }
        .help-text {
          font-size: 0.875rem;
          color: var(--text-secondary);
          margin-bottom: 0.5rem;
        }
        .generated-previews {
          margin-top: 0.5rem;
          font-size: 0.75rem;
          color: var(--text-secondary);
        }
        .mini-previews {
          display: flex;
          gap: 0.5rem;
          margin-top: 0.25rem;
        }
        .mini-previews div {
          background-color: var(--splunk-green);
          color: white;
          padding: 2px 6px;
          border-radius: 2px;
        }
        .error-text {
          color: #D32F2F;
          font-size: 0.875rem;
          margin-top: 0.5rem;
        }
      `}</style>
    </div>
  );
}
