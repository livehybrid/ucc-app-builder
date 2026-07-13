import { useState, useCallback, useMemo } from 'react';
import styled from 'styled-components';
import Button from '@splunk/react-ui/Button';
import Heading from '@splunk/react-ui/Heading';
import Message from '@splunk/react-ui/Message';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import CollapsiblePanel from '@splunk/react-ui/CollapsiblePanel';
import Badge from '@splunk/react-ui/Badge';
import File from '@splunk/react-ui/File';
import Switch from '@splunk/react-ui/Switch';
import { variables } from '@splunk/themes';
import { importAppFromZip } from '../lib/importer';
import { fingerprintWithUCCGen } from '../lib/fingerprint';
import type { ImportAnalysis } from '../types/manifest';

interface ImportExportProps {
  onImportComplete: (analysis: ImportAnalysis) => void;
}

type ImportMode = 'source' | 'all';

const ImportContainer = styled.div`
  max-width: 960px;
  margin: 32px auto;
  padding: 0 32px;
  width: 100%;
`;

const ModeToggleRow = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  background: ${variables.backgroundColorDialog};
  border: 1px solid ${variables.borderColor};
  border-radius: 8px;
  margin-bottom: 24px;
`;

const ModeLabel = styled.span`
  font-weight: 600;
  color: ${variables.contentColorDefault};
  font-size: 0.9rem;
`;

const ModeDescription = styled.span`
  color: #9b9ea3;
  font-size: 0.85rem;
`;

const FileListScroll = styled.div`
  max-height: 280px;
  overflow-y: auto;
  margin-top: 4px;
`;

const FileRow = styled.label<{ $dimmed?: boolean }>`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 4px;
  cursor: pointer;
  opacity: ${({ $dimmed }) => ($dimmed ? 0.45 : 1)};
  transition: background 0.15s;

  &:hover {
    background: rgba(101, 166, 55, 0.08);
    opacity: 1;
  }
`;

const FilePath = styled.span`
  font-family: 'Splunk Platform Mono', Inconsolata, Consolas, monospace;
  font-size: 0.82rem;
  color: ${variables.contentColorDefault};
  word-break: break-all;
`;

const SectionMeta = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
`;

const ImportSummary = styled.div`
  padding: 14px 16px;
  background: ${variables.backgroundColorDialog};
  border: 1px solid ${variables.borderColor};
  border-radius: 8px;
  margin-top: 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
`;

function defaultIncluded(origin: string, mode: ImportMode) {
  if (mode === 'all') return true;
  if (origin === 'modified-generated') return true; // always include user-modified files
  return origin !== 'generated';
}

export function ImportExport({ onImportComplete }: ImportExportProps) {
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadedFilename, setUploadedFilename] = useState<string | null>(null);
  const [importMode, setImportMode] = useState<ImportMode>('source');
  const [fileOverrides, setFileOverrides] = useState<Record<string, boolean>>({});
  const [isFingerprinting, setIsFingerprinting] = useState(false);
  const [fingerprintAvailable, setFingerprintAvailable] = useState<boolean | null>(null);
  const [fingerprintError, setFingerprintError] = useState<string | null>(null);

  const handleRequestAdd: (files: globalThis.File[]) => void = useCallback(async (files) => {
    const file = files[0];
    if (!file) return;
    setUploadedFilename(file.name);
    setIsAnalyzing(true);
    setError(null);
    setAnalysis(null);
    setFileOverrides({});
    setFingerprintAvailable(null);
    setFingerprintError(null);
    try {
      const result = await importAppFromZip(file);
      setAnalysis(result);

      // Background pass: run ucc-gen and reclassify files against actual generated output
      if (result.isUCCApp) {
        setIsFingerprinting(true);
        fingerprintWithUCCGen(result)
          .then(({ analysis: refined, available, error }) => {
            setFingerprintAvailable(available);
            if (error) setFingerprintError(error);
            if (available) setAnalysis(refined);
          })
          .finally(() => setIsFingerprinting(false));
      }
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
    setFileOverrides({});
    setFingerprintAvailable(null);
    setFingerprintError(null);
  }, []);

  const handleModeChange = useCallback((mode: ImportMode) => {
    setImportMode(mode);
    setFileOverrides({});
  }, []);

  const isFileIncluded = useCallback(
    (path: string, origin: string) => {
      if (path in fileOverrides) return fileOverrides[path];
      return defaultIncluded(origin, importMode);
    },
    [fileOverrides, importMode],
  );

  const toggleFile = useCallback((path: string, origin: string) => {
    setFileOverrides((prev) => {
      const current = path in prev ? prev[path] : defaultIncluded(origin, importMode);
      return { ...prev, [path]: !current };
    });
  }, [importMode]);

  const sourceFiles = useMemo(() => analysis?.files.filter((f) => f.origin === 'source') ?? [], [analysis]);
  const modifiedGeneratedFiles = useMemo(() => analysis?.files.filter((f) => f.origin === 'modified-generated') ?? [], [analysis]);
  const generatedFiles = useMemo(() => analysis?.files.filter((f) => f.origin === 'generated') ?? [], [analysis]);
  const customFiles = useMemo(() => analysis?.files.filter((f) => f.origin === 'custom') ?? [], [analysis]);

  const selectedCount = useMemo(() => {
    if (!analysis) return 0;
    return analysis.files.filter((f) => isFileIncluded(f.path, f.origin)).length;
  }, [analysis, isFileIncluded]);

  const handleImport = useCallback(() => {
    if (!analysis) return;
    const filtered: ImportAnalysis = {
      ...analysis,
      files: analysis.files.filter((f) => isFileIncluded(f.path, f.origin)),
    };
    onImportComplete(filtered);
  }, [analysis, isFileIncluded, onImportComplete]);

  const renderFileList = (files: ImportAnalysis['files'], origin: string) => (
    <FileListScroll>
      {files.map((f) => {
        const included = isFileIncluded(f.path, origin);
        return (
          <FileRow key={f.path} $dimmed={!included} onClick={() => toggleFile(f.path, origin)}>
            <input
              type="checkbox"
              checked={included}
              onChange={() => toggleFile(f.path, origin)}
              style={{ cursor: 'pointer', flexShrink: 0 }}
              onClick={(e) => e.stopPropagation()}
            />
            <FilePath>{f.path}</FilePath>
          </FileRow>
        );
      })}
    </FileListScroll>
  );

  const selectedInGroup = (files: ImportAnalysis['files']) =>
    files.filter((f) => isFileIncluded(f.path, f.origin)).length;

  return (
    <ImportContainer>
      <Heading level={1}>Import Existing App</Heading>
      <p style={{ color: '#9b9ea3', marginBottom: 24 }}>
        Upload a Splunk app package. By default only source files are imported — ucc-gen will recreate the rest.
      </p>

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
        <div style={{ marginTop: 32 }}>
          <div style={{ display: 'flex', gap: 16, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
            <Heading level={2} style={{ margin: 0 }}>
              {analysis.displayName} <span style={{ color: '#9b9ea3', fontWeight: 400, fontSize: '1rem' }}>v{analysis.version}</span>
            </Heading>
            {analysis.isUCCApp && <Badge label="UCC App" style={{ backgroundColor: '#65A637' }} />}
          </div>

          {analysis.warnings.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              {analysis.warnings.map((w, i) => (
                <Message key={i} type="warning">{w}</Message>
              ))}
            </div>
          )}

          {isFingerprinting && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, color: '#9b9ea3', fontSize: '0.88rem' }}>
              <WaitSpinner size="small" />
              <span>Verifying with ucc-gen — reclassifying modified vs generated files…</span>
            </div>
          )}
          {!isFingerprinting && fingerprintAvailable === true && !fingerprintError && (
            <Message type="success" style={{ marginBottom: 16 }}>
              File origins verified with ucc-gen — modified files are highlighted as &ldquo;modified-generated&rdquo;.
            </Message>
          )}
          {!isFingerprinting && fingerprintAvailable === false && analysis.isUCCApp && (
            <Message type="warning" style={{ marginBottom: 16 }}>
              ucc-gen not available — file origins are estimated from path patterns. Install ucc-gen for precise detection.
            </Message>
          )}
          {!isFingerprinting && fingerprintError && (
            <Message type="warning" style={{ marginBottom: 16 }}>
              ucc-gen verification failed: {fingerprintError}. Using pattern-based classification.
            </Message>
          )}

          <ModeToggleRow>
            <ModeLabel>Import mode:</ModeLabel>
            <Switch
              value={importMode === 'all'}
              onClick={() => handleModeChange(importMode === 'source' ? 'all' : 'source')}
              appearance="toggle"
            >
              Include UCC-generated files
            </Switch>
            <ModeDescription>
              {importMode === 'source'
                ? 'Only source files — ucc-gen rebuilds everything else'
                : 'All files including generated artefacts'}
            </ModeDescription>
          </ModeToggleRow>

          <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            <Badge label={`${sourceFiles.length} Source`} style={{ backgroundColor: '#65A637' }} />
            <Badge label={`${customFiles.length} Custom`} />
            {modifiedGeneratedFiles.length > 0 && (
              <Badge label={`${modifiedGeneratedFiles.length} Modified`} style={{ backgroundColor: '#D94F00' }} />
            )}
            <Badge label={`${generatedFiles.length} Generated`} style={{ backgroundColor: '#0076D3' }} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {sourceFiles.length > 0 && (
              <CollapsiblePanel
                title={
                  <SectionMeta>
                    <span>Source Files</span>
                    <Badge label={`${selectedInGroup(sourceFiles)} / ${sourceFiles.length} selected`} style={{ backgroundColor: '#65A637' }} />
                  </SectionMeta>
                }
                defaultOpen
              >
                {renderFileList(sourceFiles, 'source')}
              </CollapsiblePanel>
            )}

            {customFiles.length > 0 && (
              <CollapsiblePanel
                title={
                  <SectionMeta>
                    <span>Custom Files</span>
                    <Badge label={`${selectedInGroup(customFiles)} / ${customFiles.length} selected`} />
                  </SectionMeta>
                }
                defaultOpen
              >
                {renderFileList(customFiles, 'custom')}
              </CollapsiblePanel>
            )}

            {modifiedGeneratedFiles.length > 0 && (
              <CollapsiblePanel
                title={
                  <SectionMeta>
                    <span>Modified Generated Files</span>
                    <Badge
                      label={`${selectedInGroup(modifiedGeneratedFiles)} / ${modifiedGeneratedFiles.length} selected`}
                      style={{ backgroundColor: '#D94F00' }}
                    />
                  </SectionMeta>
                }
                defaultOpen
              >
                <p style={{ color: '#9b9ea3', fontSize: '0.85rem', margin: '0 0 8px 0' }}>
                  These files are generated by <code>ucc-gen</code> but differ from the default output — they contain user modifications and will be imported as source.
                </p>
                {renderFileList(modifiedGeneratedFiles, 'modified-generated')}
              </CollapsiblePanel>
            )}

            {generatedFiles.length > 0 && (
              <CollapsiblePanel
                title={
                  <SectionMeta>
                    <span>UCC-Generated Files</span>
                    <Badge
                      label={`${selectedInGroup(generatedFiles)} / ${generatedFiles.length} selected`}
                      style={{ backgroundColor: importMode === 'all' ? '#0076D3' : undefined }}
                    />
                  </SectionMeta>
                }
              >
                <p style={{ color: '#9b9ea3', fontSize: '0.85rem', margin: '0 0 8px 0' }}>
                  These are rebuilt by <code>ucc-gen</code>. Toggle individual files to override the mode setting.
                </p>
                {renderFileList(generatedFiles, 'generated')}
              </CollapsiblePanel>
            )}
          </div>

          <ImportSummary>
            <span style={{ color: 'inherit' }}>
              <strong>{selectedCount}</strong> of {analysis.files.length} files will be imported
            </span>
            <Button
              appearance="primary"
              onClick={handleImport}
              label="Import to Editor"
              disabled={selectedCount === 0}
            />
          </ImportSummary>
        </div>
      )}
    </ImportContainer>
  );
}
