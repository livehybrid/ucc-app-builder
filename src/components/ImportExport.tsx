import { useState, useCallback } from 'react';
import type { ImportAnalysis, UCCBuildManifest } from '../types/manifest';
import { importAppFromZip, createManifestFromImport } from '../lib/importer';
import { generateExportSummary, downloadSourceZip } from '../lib/exporter';

interface ImportExportProps {
  onImportComplete: (analysis: ImportAnalysis) => void;
}

export function ImportExport({ onImportComplete }: ImportExportProps) {
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [manifest, setManifest] = useState<UCCBuildManifest | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsLoading(true);
    setError(null);

    try {
      const result = await importAppFromZip(file);
      const manifestResult = createManifestFromImport(result);
      setAnalysis(result);
      setManifest(manifestResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to import app');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleExportSource = useCallback(async () => {
    if (!analysis || !manifest) return;
    await downloadSourceZip(analysis, manifest);
  }, [analysis, manifest]);

  const handleContinue = useCallback(() => {
    if (analysis) {
      onImportComplete(analysis);
    }
  }, [analysis, onImportComplete]);

  const summary = analysis ? generateExportSummary(analysis) : null;

  return (
    <div className="import-export">
      <h2>Import Existing App</h2>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
        Import an existing Splunk app to extract source files for CI/CD workflows.
        The system will identify which files are source code vs generated.
      </p>

      <div className="form-group">
        <label htmlFor="import-file">Select App Package (.zip, .tgz, .spl)</label>
        <input
          id="import-file"
          type="file"
          accept=".zip,.tgz,.spl,.tar.gz"
          onChange={handleFileSelect}
          disabled={isLoading}
        />
      </div>

      {isLoading && (
        <div className="loading">Analyzing app structure...</div>
      )}

      {error && (
        <div className="error-message">{error}</div>
      )}

      {analysis && summary && (
        <div className="analysis-results">
          <div className="success-message">
            {analysis.isUCCApp ? '✓ UCC-based app detected' : '⚠ Non-UCC app (limited support)'}
          </div>

          <div className="review-section">
            <h3>App Information</h3>
            <div className="review-item">
              <span className="label">App ID:</span>
              <span className="value">{analysis.appId}</span>
            </div>
            <div className="review-item">
              <span className="label">Display Name:</span>
              <span className="value">{analysis.displayName}</span>
            </div>
            <div className="review-item">
              <span className="label">Version:</span>
              <span className="value">{analysis.version}</span>
            </div>
          </div>

          <div className="review-section">
            <h3>File Analysis</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '1rem' }}>
              Files are classified by origin to determine what needs version control.
            </p>

            <div className="file-category">
              <div className="category-header source">
                <span className="category-icon">📁</span>
                <span className="category-name">Source Files ({summary.source.length})</span>
                <span className="category-desc">Version controlled, required for builds</span>
              </div>
              {summary.source.length > 0 && (
                <ul className="file-list">
                  {summary.source.slice(0, 5).map(f => <li key={f}>{f}</li>)}
                  {summary.source.length > 5 && (
                    <li className="more">...and {summary.source.length - 5} more</li>
                  )}
                </ul>
              )}
            </div>

            <div className="file-category">
              <div className="category-header custom">
                <span className="category-icon">✨</span>
                <span className="category-name">Custom Files ({summary.custom.length})</span>
                <span className="category-desc">User-added files, version controlled</span>
              </div>
              {summary.custom.length > 0 && (
                <ul className="file-list">
                  {summary.custom.slice(0, 5).map(f => <li key={f}>{f}</li>)}
                  {summary.custom.length > 5 && (
                    <li className="more">...and {summary.custom.length - 5} more</li>
                  )}
                </ul>
              )}
            </div>

            <div className="file-category">
              <div className="category-header generated">
                <span className="category-icon">⚙️</span>
                <span className="category-name">Generated Files ({summary.generated.length})</span>
                <span className="category-desc">Created by ucc-gen, can be regenerated</span>
              </div>
              {summary.generated.length > 0 && (
                <ul className="file-list">
                  {summary.generated.slice(0, 5).map(f => <li key={f}>{f}</li>)}
                  {summary.generated.length > 5 && (
                    <li className="more">...and {summary.generated.length - 5} more</li>
                  )}
                </ul>
              )}
            </div>

            {summary.modifiedGenerated.length > 0 && (
              <div className="file-category">
                <div className="category-header modified">
                  <span className="category-icon">⚠️</span>
                  <span className="category-name">Modified Generated ({summary.modifiedGenerated.length})</span>
                  <span className="category-desc">Generated but manually edited</span>
                </div>
                <ul className="file-list">
                  {summary.modifiedGenerated.map(f => <li key={f}>{f}</li>)}
                </ul>
              </div>
            )}
          </div>

          {analysis.warnings.length > 0 && (
            <div className="review-section">
              <h3>Warnings</h3>
              <ul className="warning-list">
                {analysis.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}

          <div className="wizard-actions">
            <button className="btn btn-secondary" onClick={handleExportSource}>
              Export Source Files (.zip)
            </button>
            <button className="btn btn-primary" onClick={handleContinue}>
              Continue to Editor
            </button>
          </div>
        </div>
      )}

      <style>{`
        .import-export {
          background-color: var(--splunk-gray);
          border-radius: 8px;
          padding: 2rem;
        }
        .loading {
          padding: 2rem;
          text-align: center;
          color: var(--text-secondary);
        }
        .error-message {
          background-color: rgba(211, 47, 47, 0.2);
          border: 1px solid #D32F2F;
          border-radius: 4px;
          padding: 1rem;
          margin: 1rem 0;
        }
        .analysis-results {
          margin-top: 1.5rem;
        }
        .file-category {
          margin-bottom: 1rem;
          background-color: var(--splunk-dark);
          border-radius: 4px;
          overflow: hidden;
        }
        .category-header {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.75rem 1rem;
          border-left: 3px solid;
        }
        .category-header.source { border-color: var(--splunk-green); }
        .category-header.custom { border-color: #9C27B0; }
        .category-header.generated { border-color: #666; }
        .category-header.modified { border-color: #F58220; }
        .category-name {
          font-weight: bold;
        }
        .category-desc {
          color: var(--text-secondary);
          font-size: 0.875rem;
          margin-left: auto;
        }
        .file-list {
          list-style: none;
          padding: 0.5rem 1rem;
          font-family: monospace;
          font-size: 0.875rem;
          max-height: 150px;
          overflow-y: auto;
        }
        .file-list li {
          padding: 0.25rem 0;
          color: var(--text-secondary);
        }
        .file-list li.more {
          color: var(--splunk-green);
          font-style: italic;
        }
        .warning-list {
          list-style: none;
          padding: 0;
        }
        .warning-list li {
          padding: 0.5rem;
          background-color: rgba(245, 130, 32, 0.1);
          margin-bottom: 0.25rem;
          border-radius: 4px;
          color: #F58220;
        }
      `}</style>
    </div>
  );
}
