import { useState, useCallback, useEffect } from 'react';
import styled from 'styled-components';
import Button from '@splunk/react-ui/Button';
import Heading from '@splunk/react-ui/Heading';
import Message from '@splunk/react-ui/Message';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import CollapsiblePanel from '@splunk/react-ui/CollapsiblePanel';
import List from '@splunk/react-ui/List';
import Badge from '@splunk/react-ui/Badge';
import File from '@splunk/react-ui/File';
import { importAppFromZip } from '../lib/importer';
import {
  installedAppsAvailable,
  listInstalledApps,
  importInstalledApp,
  type InstalledApp,
} from '../lib/installedApps';
import type { ImportAnalysis } from '../types/manifest';

interface ImportExportProps {
  onImportComplete: (analysis: ImportAnalysis) => void;
}

const ImportContainer = styled.div`
  max-width: 960px;
  margin: 32px auto;
  padding: 0 32px;
  width: 100%;
`;

const AnalysisResults = styled.div`
  margin-top: 32px;
`;

const FileCategorySection = styled.div`
  margin-bottom: 8px;
`;

export function ImportExport({ onImportComplete }: ImportExportProps) {
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadedFilename, setUploadedFilename] = useState<string | null>(null);
  // Seed-from-installed (native Splunk app only): add-ons already installed on this Splunk.
  const [installed, setInstalled] = useState<InstalledApp[]>([]);
  const [loadingInstalled, setLoadingInstalled] = useState(false);

  useEffect(() => {
    if (!installedAppsAvailable()) return;
    setLoadingInstalled(true);
    listInstalledApps()
      .then(setInstalled)
      .catch(() => {})
      .finally(() => setLoadingInstalled(false));
  }, []);

  const seedFromInstalled = useCallback(async (appId: string) => {
    setUploadedFilename(appId);
    setIsAnalyzing(true);
    setError(null);
    setAnalysis(null);
    try {
      setAnalysis(await importInstalledApp(appId));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsAnalyzing(false);
    }
  }, []);

  const handleRequestAdd: (files: globalThis.File[]) => void = useCallback(async (files) => {
    const file = files[0];
    if (!file) return;

    setUploadedFilename(file.name);
    setIsAnalyzing(true);
    setError(null);
    setAnalysis(null);

    try {
      const result = await importAppFromZip(file);
      setAnalysis(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsAnalyzing(false);
    }
  }, []);

  const handleRequestRemove = useCallback(() => {
    setUploadedFilename(null);
    setAnalysis(null);
    setError(null);
  }, []);

  const sourceFiles = analysis?.files.filter((f) => f.origin === 'source') || [];
  const generatedFiles =
    analysis?.files.filter((f) => f.origin === 'generated' || f.origin === 'modified-generated') ||
    [];
  const customFiles = analysis?.files.filter((f) => f.origin === 'custom') || [];

  const renderFileList = (files: ImportAnalysis['files']) => (
    <List>
      {files.map((f) => (
        <List.Item key={f.path}>
          <span
            style={{
              fontFamily: 'Splunk Platform Mono, Inconsolata, Consolas, monospace',
              fontSize: '0.85rem',
            }}
          >
            {f.path}
          </span>
        </List.Item>
      ))}
    </List>
  );

  return (
    <ImportContainer>
      <Heading level={1}>Import Existing App</Heading>
      <p style={{ color: '#9b9ea3', marginBottom: 24 }}>
        Upload a Splunk app ZIP file to analyze its structure and extract source files.
      </p>

      {installedAppsAvailable() && (
        <div style={{ marginBottom: 24 }} data-testid="seed-installed">
          <CollapsiblePanel title="Seed from an add-on installed on this Splunk" defaultOpen>

            <p style={{ color: '#9b9ea3', marginTop: 0 }}>
              Load an installed UCC add-on's source into the builder to extend it with the AI -
              no manual export. (Vendored libraries, bytecode and instance-local config are
              excluded.)
            </p>
            {loadingInstalled ? (
              <WaitSpinner />
            ) : installed.length === 0 ? (
              <p style={{ color: '#9b9ea3' }}>No UCC add-ons (with a globalConfig.json) found.</p>
            ) : (
              <List>
                {installed.map((a) => (
                  <List.Item key={a.appId}>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        width: '100%',
                        gap: 8,
                      }}
                    >
                      <span>
                        <strong>{a.displayName}</strong>{' '}
                        <code style={{ color: '#9b9ea3', fontSize: '0.85rem' }}>{a.appId}</code>
                        {a.version ? ` · v${a.version}` : ''}
                      </span>
                      <Button
                        appearance="default"
                        label="Seed"
                        disabled={isAnalyzing}
                        onClick={() => seedFromInstalled(a.appId)}
                      />
                    </div>
                  </List.Item>
                ))}
              </List>
            )}
          </CollapsiblePanel>
        </div>
      )}

      <File
        accept=".tgz,.zip,.spl,.tar.gz"
        onRequestAdd={handleRequestAdd}
        onRequestRemove={handleRequestRemove}
        disabled={isAnalyzing}
        supportsMessage="Supports Splunk app packages (.tgz, .zip, .spl)"
      >
        {uploadedFilename && (
          <File.Item name={uploadedFilename} uploadPercentage={isAnalyzing ? 50 : undefined} />
        )}
      </File>

      {isAnalyzing && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 32 }}>
          <WaitSpinner />
          <span>Analyzing app structure...</span>
        </div>
      )}

      {error && (
        <div style={{ marginTop: 32 }}>
          <Message type="error">{error}</Message>
        </div>
      )}

      {analysis && (
        <AnalysisResults>
          <Heading level={2}>Analysis Results</Heading>
          <div style={{ display: 'flex', gap: 16, marginBottom: 24, marginTop: 16 }}>
            <Badge label={`${analysis.files.length} Total Files`} />
            <Badge label={`${sourceFiles.length} Source`} backgroundColor="#65A637" />
            <Badge label={`${generatedFiles.length} Generated`} backgroundColor="#0076D3" />
            <Badge label={`${customFiles.length} Custom`} />
          </div>

          {analysis.warnings.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              {analysis.warnings.map((warning, i) => (
                <Message key={i} type="warning">
                  {warning}
                </Message>
              ))}
            </div>
          )}

          <FileCategorySection>
            <CollapsiblePanel title={`Source Files (${sourceFiles.length})`} defaultOpen>
              {renderFileList(sourceFiles)}
            </CollapsiblePanel>
          </FileCategorySection>

          <FileCategorySection>
            <CollapsiblePanel title={`Generated Files (${generatedFiles.length})`}>
              {renderFileList(generatedFiles)}
            </CollapsiblePanel>
          </FileCategorySection>

          {customFiles.length > 0 && (
            <FileCategorySection>
              <CollapsiblePanel title={`Custom Files (${customFiles.length})`}>
                {renderFileList(customFiles)}
              </CollapsiblePanel>
            </FileCategorySection>
          )}

          <div style={{ marginTop: 24 }}>
            <Button
              appearance="primary"
              onClick={() => onImportComplete(analysis)}
              label="Import to Editor"
            />
          </div>
        </AnalysisResults>
      )}
    </ImportContainer>
  );
}
