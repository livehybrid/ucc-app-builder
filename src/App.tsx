import { useState, useCallback, useEffect } from 'react';
import { Wizard } from './components/Wizard';
import { FileBrowser } from './components/FileBrowser';
import { ImportExport } from './components/ImportExport';
import { BuildPanel } from './components/BuildPanel';
import { VirtualFileSystem, generateSplunkApp, downloadAppAsZip, loadImportToVFS } from './lib';
import { saveState, loadState, clearState, saveVFS, loadVFS, hasSavedState } from './lib/persistence';
import type { WizardState, ImportAnalysis } from './types';
import { DEFAULT_WIZARD_STATE } from './types';

type AppMode = 'welcome' | 'wizard' | 'import' | 'files';

function App() {
  const [mode, setMode] = useState<AppMode>('welcome');
  const [wizardState, setWizardState] = useState<WizardState>(DEFAULT_WIZARD_STATE);
  const [vfs] = useState(() => new VirtualFileSystem());
  const [generated, setGenerated] = useState(false);
  const [appName, setAppName] = useState('splunk_app');

  // Restore saved state
  const handleRestore = useCallback(() => {
    const savedState = loadState();
    const savedFiles = loadVFS();

    if (savedState) {
      setMode(savedState.mode);
      setWizardState(savedState.wizardState);
      setAppName(savedState.appName);
      setGenerated(savedState.generated);

      // Restore VFS if files were saved
      if (savedFiles && savedFiles.length > 0) {
        vfs.clear();
        for (const file of savedFiles) {
          vfs.writeFile(file.path, file.content);
        }
      }
    }
  }, [vfs]);

  // Check for saved state on mount and auto-restore
  useEffect(() => {
    if (hasSavedState()) {
      handleRestore();
    }
  }, [handleRestore]);

  // Start fresh
  const handleStartFresh = useCallback(() => {
    clearState();
    setMode('welcome');
    setWizardState(DEFAULT_WIZARD_STATE);
    setGenerated(false);
    setAppName('splunk_app');
    vfs.clear();
  }, [vfs]);

  // Save state whenever it changes
  useEffect(() => {
    saveState({
      mode,
      wizardState,
      appName,
      generated,
    });

    // Save VFS if we have generated files
    if (generated) {
      const files = vfs.getAllFiles();
      saveVFS(files);
    }
  }, [mode, wizardState, appName, generated, vfs]);

  const handleGenerate = useCallback(() => {
    generateSplunkApp(vfs, {
      metadata: wizardState.metadata,
      branding: wizardState.branding,
      components: wizardState.components,
    });
    setAppName(wizardState.metadata.name || 'splunk_app');
    setGenerated(true);
    setMode('files');
  }, [vfs, wizardState]);

  const handleDownload = useCallback(async () => {
    await downloadAppAsZip(vfs, appName);
  }, [vfs, appName]);

  const handleImportComplete = useCallback((analysis: ImportAnalysis) => {
    loadImportToVFS(vfs, analysis);
    setAppName(analysis.appId);
    setGenerated(true);
    setMode('files');
  }, [vfs]);

  const handleReset = useCallback(() => {
    if (confirm('Are you sure you want to start over? All progress will be lost.')) {
      handleStartFresh();
    }
  }, [handleStartFresh]);

  return (
    <div className="app">
      <header className="header">
        <h1>Splunk App Builder</h1>
        <nav>
          <button
            className={mode === 'welcome' ? 'active' : ''}
            onClick={() => setMode('welcome')}
          >
            Home
          </button>
          <button
            className={mode === 'wizard' ? 'active' : ''}
            onClick={() => setMode('wizard')}
          >
            New App
          </button>
          <button
            className={mode === 'import' ? 'active' : ''}
            onClick={() => setMode('import')}
          >
            Import
          </button>
          <button
            className={mode === 'files' ? 'active' : ''}
            onClick={() => setMode('files')}
            disabled={!generated}
          >
            Files
          </button>
          {generated && (
            <>
              <button onClick={handleDownload} className="btn-primary">
                Download ZIP
              </button>
              <button onClick={handleReset} className="btn-danger" title="Start over">
                Reset
              </button>
            </>
          )}
        </nav>
      </header>

      <main className="main">
        {mode === 'welcome' && (
          <div className="welcome">
            <h2>Welcome to Splunk App Builder</h2>
            <p>Build UCC-based Splunk apps with a modern, CI/CD-friendly workflow.</p>

            <div className="welcome-cards">
              <div className="welcome-card" onClick={() => setMode('wizard')}>
                <div className="card-icon">🚀</div>
                <h3>Create New App</h3>
                <p>Use the wizard to build a new Splunk app from scratch with guided steps.</p>
              </div>

              <div className="welcome-card" onClick={() => setMode('import')}>
                <div className="card-icon">📦</div>
                <h3>Import Existing App</h3>
                <p>Import an existing app to extract source files for version control and CI/CD.</p>
              </div>
            </div>

            <div className="welcome-features">
              <h3>Features</h3>
              <ul>
                <li><strong>Source Tracking</strong> - Identifies which files are source vs generated</li>
                <li><strong>CI/CD Ready</strong> - Export only source files for version control</li>
                <li><strong>UCC Framework</strong> - Generates valid globalConfig.json</li>
                <li><strong>ZIP Packaging</strong> - Download ready-to-install Splunk apps</li>
                <li><strong>Auto-Save</strong> - Your progress is automatically saved</li>
              </ul>
            </div>
          </div>
        )}

        {mode === 'wizard' && (
          <Wizard
            state={wizardState}
            onChange={setWizardState}
            onGenerate={handleGenerate}
          />
        )}

        {mode === 'import' && (
          <ImportExport onImportComplete={handleImportComplete} />
        )}

        {mode === 'files' && generated && (
          <div className="files-view">
            <BuildPanel
              files={vfs.getRoot()}
              appId={wizardState.metadata.appId || wizardState.metadata.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}
            />
            <FileBrowser
              vfs={vfs}
              wizardState={wizardState}
              onUpdateConfig={(newState) => {
                setWizardState(newState);
                generateSplunkApp(vfs, {
                  metadata: newState.metadata,
                  branding: newState.branding,
                  components: newState.components,
                });
                setGenerated(true);
              }}
            />
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
