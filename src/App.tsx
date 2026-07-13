import { useState, useCallback, useEffect, useRef } from 'react';
import styled from 'styled-components';
import Button from '@splunk/react-ui/Button';
import Heading from '@splunk/react-ui/Heading';
import Message from '@splunk/react-ui/Message';
import { variables } from '@splunk/themes';
import Rocket from '@splunk/react-icons/Rocket';
import ArrowCircleInRight from '@splunk/react-icons/ArrowCircleInRight';
import Cog from '@splunk/react-icons/Cog';
import PuzzlePiece from '@splunk/react-icons/PuzzlePiece';
import Lightning from '@splunk/react-icons/Lightning';
import FileZip from '@splunk/react-icons/FileZip';
import Checkmark from '@splunk/react-icons/Checkmark';
import Pencil from '@splunk/react-icons/Pencil';
import { Wizard } from './components/Wizard';
import { FileBrowser } from './components/FileBrowser';
import { ImportExport } from './components/ImportExport';
import { PasteConfigPanel } from './components/PasteConfigPanel';
import { BuildPanel } from './components/BuildPanel';
import { AIChatPanel } from './components/AIChatPanel';
import { GitHubPanel } from './components/GitHubPanel';
import { GettingStartedPage } from './components/GettingStartedPage';
import type { GitHubSession } from './types/github';
import Modal from '@splunk/react-ui/Modal';
import { VirtualFileSystem } from './lib/vfs';
import { generateSplunkApp } from './lib/generator';
import { downloadAppAsZip } from './lib/packager';
import { loadImportToVFS } from './lib/importer';
import { saveState, loadState, clearState, saveVFS, loadVFS, hasSavedState } from './lib/persistence';
import type { WizardState, ImportAnalysis } from './types';
import { DEFAULT_WIZARD_STATE } from './types';

type AppMode = 'welcome' | 'wizard' | 'import' | 'paste-config' | 'files' | 'getting-started';

const AppContainer = styled.div`
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: ${variables.backgroundColorPage};
  color: ${variables.contentColorDefault};
`;

const Header = styled.header`
  background: ${variables.backgroundColorDialog};
  padding: 0 24px;
  height: 56px;
  border-bottom: 1px solid ${variables.borderColor};
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-shrink: 0;
`;

const HeaderTitle = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 1.25rem;
  font-weight: 700;
  letter-spacing: -0.5px;
`;

const AppLogo = styled.div`
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: linear-gradient(135deg, #65A637, #8BC34A);
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  box-shadow: 0 4px 12px rgba(101, 166, 55, 0.4);
  
  svg {
    width: 18px;
    height: 18px;
  }
`;

const AppName = styled.div`
  color: ${variables.contentColorDefault};
  span {
    background: linear-gradient(90deg, #65A637, #A2D964);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    margin-left: 4px;
    font-weight: 800;
  }
`;

const Nav = styled.nav`
  display: flex;
  gap: 8px;
  align-items: center;
`;

const Main = styled.main`
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
`;

const WelcomeContainer = styled.div`
  max-width: 1100px;
  margin: 40px auto;
  padding: 0 32px;
  width: 100%;
`;

const WelcomeIntro = styled.div`
  text-align: center;
  margin-bottom: 40px;
`;

const Tagline = styled.p`
  color: #9b9ea3;
  font-size: 1.15rem;
  margin-top: 12px;
  font-style: normal;
  font-weight: 400;
`;

const ChoiceCardsContainer = styled.div`
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 24px;
  margin-bottom: 48px;
  
  @media (max-width: 768px) {
    grid-template-columns: 1fr;
  }
`;

const ChoiceCard = styled.div`
  background: ${variables.backgroundColorDialog};
  border: 1px solid ${variables.borderColor};
  border-radius: 12px;
  padding: 28px;
  cursor: pointer;
  transition: all 0.25s ease;
  position: relative;
  overflow: hidden;
  
  &:hover {
    transform: translateY(-4px);
    border-color: #65A637;
    box-shadow: 0 8px 32px rgba(101, 166, 55, 0.15);
  }
  
  &::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 4px;
    background: linear-gradient(90deg, #65A637, #8BC34A);
    opacity: 0;
    transition: opacity 0.25s ease;
  }
  
  &:hover::before {
    opacity: 1;
  }
`;

const CardIconWrapper = styled.div`
  width: 56px;
  height: 56px;
  border-radius: 12px;
  background: linear-gradient(135deg, rgba(101, 166, 55, 0.2), rgba(101, 166, 55, 0.1));
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 20px;
  color: #65A637;
  
  svg {
    width: 28px;
    height: 28px;
  }
`;

const CardTitle = styled.h3`
  font-size: 1.25rem;
  font-weight: 600;
  color: ${variables.contentColorDefault};
  margin: 0 0 6px 0;
`;

const CardSubtitle = styled.span`
  font-size: 0.85rem;
  color: #65A637;
  font-weight: 500;
  display: block;
  margin-bottom: 12px;
`;

const CardDescription = styled.p`
  font-size: 0.95rem;
  color: #9b9ea3;
  margin: 0;
  line-height: 1.6;
`;

const SectionTitle = styled.h2`
  font-size: 1.5rem;
  font-weight: 600;
  color: ${variables.contentColorDefault};
  text-align: center;
  margin-bottom: 32px;
`;

const HowItWorksSection = styled.div`
  margin-top: 48px;
  padding-top: 48px;
  border-top: 1px solid ${variables.borderColor};
`;

const StepsContainer = styled.div`
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  position: relative;
  
  @media (max-width: 900px) {
    grid-template-columns: repeat(2, 1fr);
  }
  
  @media (max-width: 500px) {
    grid-template-columns: 1fr;
  }
`;

const StepCard = styled.div`
  text-align: center;
  padding: 24px 16px;
  background: ${variables.backgroundColorDialog};
  border: 1px solid ${variables.borderColor};
  border-radius: 12px;
  position: relative;
`;

const StepNumber = styled.div`
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: linear-gradient(135deg, #65A637, #8BC34A);
  color: white;
  font-weight: 700;
  font-size: 1rem;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 16px;
`;

const StepIconWrapper = styled.div`
  width: 48px;
  height: 48px;
  border-radius: 10px;
  background: rgba(101, 166, 55, 0.1);
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 12px;
  color: #65A637;
  
  svg {
    width: 24px;
    height: 24px;
  }
`;

const StepTitle = styled.h4`
  font-size: 1rem;
  font-weight: 600;
  color: ${variables.contentColorDefault};
  margin: 0 0 8px 0;
`;

const StepDescription = styled.p`
  font-size: 0.85rem;
  color: #9b9ea3;
  margin: 0;
  line-height: 1.5;
`;

const FeaturesGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  margin-top: 48px;
  
  @media (max-width: 768px) {
    grid-template-columns: 1fr;
  }
`;

const FeatureItem = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px;
  background: ${variables.backgroundColorDialog};
  border-radius: 8px;
  border: 1px solid ${variables.borderColor};
`;

const FeatureIcon = styled.div`
  color: #65A637;
  flex-shrink: 0;
  margin-top: 2px;
  
  svg {
    width: 18px;
    height: 18px;
  }
`;

const FeatureText = styled.div`
  font-size: 0.9rem;
  color: #9b9ea3;
  
  strong {
    display: block;
    color: ${variables.contentColorDefault};
    margin-bottom: 2px;
  }
`;

const FilesView = styled.div`
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 16px;
  gap: 16px;
  overflow: hidden;
`;

function App() {
  const [mode, setMode] = useState<AppMode>('welcome');
  const [wizardState, setWizardState] = useState<WizardState>(DEFAULT_WIZARD_STATE);
  const [vfs] = useState(() => new VirtualFileSystem());
  const [generated, setGenerated] = useState(false);
  const [appName, setAppName] = useState('splunk_app');
  const [developerMode, setDeveloperMode] = useState(false);
  const [gitHubSession, setGitHubSession] = useState<GitHubSession | undefined>(undefined);
  const [showGitHubModal, setShowGitHubModal] = useState(false);
  const [gitHubImportMode, setGitHubImportMode] = useState(false); // true = import from repo, false = push to repo
  const [chatOpen, setChatOpen] = useState(false);
  const [pendingFixItPrompt, setPendingFixItPrompt] = useState<string | null>(null);
  // Bumped on every "start fresh" so AIChatPanel below can be `key`-mounted
  // to drop in-memory chat state. localStorage is cleared in handleStartFresh
  // too — this handles the case where the panel is currently mounted.
  const [chatResetKey, setChatResetKey] = useState(0);
  // Version counter to force re-renders when VFS changes (e.g., AI writes files)
  const [vfsVersion, setVfsVersion] = useState(0);
  
  const modalReturnRef = useRef(null);

  // Restore saved state
  const handleRestore = useCallback(() => {
    const savedState = loadState();
    const savedFiles = loadVFS();

    if (savedState) {
      setMode(savedState.mode);
      setWizardState(savedState.wizardState);
      setAppName(savedState.appName);
      setGenerated(savedState.generated);
      setDeveloperMode(savedState.developerMode || false);
      setGitHubSession(savedState.gitHubSession);

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
    // Don't reset developerMode on start fresh, as it's a user preference
    vfs.clear();
    // Drop AI Assistant chat history + server-side agent session so the new
    // project starts with a blank conversation instead of inheriting the
    // previous app's context. localStorage clears the persisted log;
    // bumping chatResetKey forces AIChatPanel to remount and drop in-memory
    // state (messages, planText, todos, decisions, ongoing SSE stream).
    try {
      localStorage.removeItem('splunk-app-builder-chat-history');
      localStorage.removeItem('ucc-agent-session-id');
    } catch {
      // ignore — non-critical
    }
    setChatOpen(false);
    setChatResetKey((k) => k + 1);
  }, [vfs]);

  // Save state whenever it changes
  useEffect(() => {
    saveState({
      mode,
      wizardState,
      appName,
      generated,
      developerMode,
      gitHubSession,
    });

    if (generated) {
      const files = vfs.getAllFiles();
      saveVFS(files);
    }
    // `vfs` is a stable React ref (created once via useState lazy init) — its
    // identity never changes, so React would never re-fire this effect when
    // VFS contents mutate. `vfsVersion` is bumped by AIChatPanel via
    // onVfsChange() on every AI-driven write/patch. Without it in the deps,
    // AI-written files were never persisted and a page refresh wiped them.
  }, [mode, wizardState, appName, generated, developerMode, gitHubSession, vfs, vfsVersion]);

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
    setWizardState((prev) => ({
      ...prev,
      metadata: {
        ...prev.metadata,
        appId: analysis.appId,
        name: analysis.appId,
        displayName: analysis.displayName || analysis.appId,
        version: analysis.version || prev.metadata.version,
        ...(analysis.author ? { author: analysis.author } : {}),
        ...(analysis.email ? { email: analysis.email } : {}),
      },
    }));
    setGenerated(true);
    setMode('files');
  }, [vfs]);

  const handlePasteConfigLoad = useCallback((configJson: string) => {
    try {
      const parsed = JSON.parse(configJson);
      const meta = parsed?.meta ?? {};
      const appId: string = meta.name ?? 'imported_app';
      const displayName: string = meta.displayName ?? appId;
      const version: string = meta.version ?? '1.0.0';

      // Extract input definitions so generateSplunkApp creates _helper.py files
      const rawServices = parsed?.pages?.inputs?.services;
      const inputs: WizardState['components']['inputs'] = Array.isArray(rawServices)
        ? rawServices.map((svc: { name?: string; title?: string; entity?: unknown[] }) => ({
            name: svc.name ?? 'input',
            title: svc.title ?? svc.name ?? 'Input',
            description: '',
            entity: [],
          }))
        : [];

      const newWizardState: WizardState = {
        ...DEFAULT_WIZARD_STATE,
        metadata: {
          ...DEFAULT_WIZARD_STATE.metadata,
          appId,
          name: appId,
          displayName,
          version,
        },
        components: {
          ...DEFAULT_WIZARD_STATE.components,
          inputs,
        },
      };

      // Generate the boilerplate file structure first, then overwrite
      // globalConfig.json with the user's pasted version so nothing is lost.
      generateSplunkApp(vfs, newWizardState);
      vfs.writeFile(`${appId}/globalConfig.json`, configJson, 'user');

      setAppName(appId);
      setWizardState(newWizardState);
      setGenerated(true);
      setMode('files');
    } catch {
      // Errors are shown in PasteConfigPanel before onLoad is called; this is a safety net only.
    }
  }, [vfs]);

  const handleReset = useCallback(() => {
    if (confirm('Are you sure you want to start over? All progress will be lost.')) {
      handleStartFresh();
    }
  }, [handleStartFresh]);

  return (
    <AppContainer>
      <Header>
        <HeaderTitle>
          <AppLogo>
            <Rocket />
          </AppLogo>
          <AppName>
            Splunk App <span>Builder</span>
          </AppName>
        </HeaderTitle>
        <Nav>
          <Button
            appearance={mode === 'welcome' ? 'primary' : 'default'}
            onClick={() => setMode('welcome')}
            label="Home"
          />
          <Button
            appearance={mode === 'wizard' ? 'primary' : 'default'}
            onClick={() => {
              if (mode === 'wizard') return;
              if (generated && !confirm('Start a new app and discard current work?')) return;
              handleStartFresh();
              setMode('wizard');
            }}
            label="New App"
          />
          <Button
            appearance={mode === 'import' ? 'primary' : 'default'}
            onClick={() => {
              if (mode === 'import') return;
              if (generated && !confirm('Import a different app and discard current work?')) return;
              handleStartFresh();
              setMode('import');
            }}
            label="Import"
          />
          <Button
            appearance={mode === 'files' ? 'primary' : 'default'}
            onClick={() => setMode('files')}
            disabled={!generated}
            label="Files"
          />
          {generated && (
            <Button
              appearance={chatOpen ? 'primary' : 'default'}
              onClick={() => setChatOpen(!chatOpen)}
              label="AI Assistant"
            />
          )}
          <Button
            appearance={gitHubSession ? 'primary' : 'default'}
            onClick={() => setShowGitHubModal(true)}
            label="GitHub"
            icon={<Rocket />}
          />
          <Button
            appearance={mode === 'getting-started' ? 'primary' : 'default'}
            onClick={() => setMode('getting-started')}
            label="Guide"
          />
          <Button
            appearance={developerMode ? 'primary' : 'default'}
            onClick={() => setDeveloperMode(!developerMode)}
            label={developerMode ? 'Dev Mode: ON' : 'Dev Mode: OFF'}
            style={{ minWidth: 120 }}
          />
          {generated && (
            <>
              <Button
                appearance="primary"
                onClick={handleDownload}
                label="Download App"
                title="Download complete installable Splunk app (.zip)"
              />
              <Button
                appearance="default"
                onClick={async () => {
                  const { exportSourceZipFromVFS } = await import('./lib/exporter');
                  const { downloadBlob } = await import('./lib/packager');
                  const blob = await exportSourceZipFromVFS(vfs, appName);
                  downloadBlob(blob, `${appName}-source.zip`);
                }}
                label="Export Source"
                title="Export source files only for version control / CI-CD"
                icon={<FileZip />}
              />
              <Button
                appearance="destructive"
                onClick={handleReset}
                label="Reset"
              />
            </>
          )}
        </Nav>
      </Header>

      <Main>
        {mode === 'welcome' && (
          <WelcomeContainer>
            <WelcomeIntro>
              <Heading level={1}>Welcome to Splunk App Builder</Heading>
              <Tagline>
                Build UCC-based Splunk apps with a modern, CI/CD-friendly workflow.
              </Tagline>
            </WelcomeIntro>

            <ChoiceCardsContainer>
              {generated && (
                <ChoiceCard onClick={() => setMode('files')}>
                  <CardIconWrapper>
                    <ArrowCircleInRight />
                  </CardIconWrapper>
                  <CardTitle>Continue Current Project</CardTitle>
                  <CardSubtitle>{appName}</CardSubtitle>
                  <CardDescription>
                    Resume editing the project you were working on. Pick up where you left off.
                  </CardDescription>
                </ChoiceCard>
              )}
              <ChoiceCard onClick={() => {
                if (generated && !confirm('You have an existing project loaded. Start a new app and discard current work?\n\nClick OK to discard, or use "Continue Current Project" above to keep editing.')) return;
                // Always reset to a clean slate — even when generated is false, stale
                // wizardState (modular inputs, branding, etc.) can persist from a prior
                // session and silently pre-fill the wizard. handleStartFresh is safe
                // to call repeatedly.
                handleStartFresh();
                setMode('wizard');
              }}>
                <CardIconWrapper>
                  <Rocket />
                </CardIconWrapper>
                <CardTitle>Create New App</CardTitle>
                <CardSubtitle>Build from scratch</CardSubtitle>
                <CardDescription>
                  Use the wizard to build a new Splunk app from scratch with guided steps.
                </CardDescription>
              </ChoiceCard>

              <ChoiceCard onClick={() => {
                if (generated && !confirm('You have an existing project loaded. Import a different app and discard current work?')) return;
                handleStartFresh();
                setMode('import');
              }}>
                <CardIconWrapper>
                  <ArrowCircleInRight />
                </CardIconWrapper>
                <CardTitle>Import Existing App</CardTitle>
                <CardSubtitle>Extract source files</CardSubtitle>
                <CardDescription>
                  Import an existing app to extract source files for version control and CI/CD.
                </CardDescription>
              </ChoiceCard>

              <ChoiceCard onClick={() => {
                if (generated && !confirm('You have an existing project loaded. Start from a globalConfig.json and discard current work?')) return;
                handleStartFresh();
                setMode('paste-config');
              }}>
                <CardIconWrapper>
                  <Pencil />
                </CardIconWrapper>
                <CardTitle>Start from globalConfig.json</CardTitle>
                <CardSubtitle>Paste an existing config</CardSubtitle>
                <CardDescription>
                  Paste an existing <code>globalConfig.json</code> to scaffold the app around it — useful when migrating or extending an existing UCC app.
                </CardDescription>
              </ChoiceCard>

              <ChoiceCard onClick={() => {
                if (generated && !confirm('You have an existing project loaded. Import from GitHub and discard current work?')) return;
                handleStartFresh();
                setGitHubImportMode(true);
                setShowGitHubModal(true);
              }}>
                <CardIconWrapper>
                  <Rocket />
                </CardIconWrapper>
                <CardTitle>Import from GitHub</CardTitle>
                <CardSubtitle>Clone a repository</CardSubtitle>
                <CardDescription>
                  Connect to GitHub and import an existing UCC app from a repository.
                </CardDescription>
              </ChoiceCard>
            </ChoiceCardsContainer>

            <HowItWorksSection>
              <SectionTitle>How It Works</SectionTitle>
              <StepsContainer>
                <StepCard>
                  <StepNumber>1</StepNumber>
                  <StepIconWrapper><Cog /></StepIconWrapper>
                  <StepTitle>Configure</StepTitle>
                  <StepDescription>Set up app details, branding, and metadata</StepDescription>
                </StepCard>
                <StepCard>
                  <StepNumber>2</StepNumber>
                  <StepIconWrapper><PuzzlePiece /></StepIconWrapper>
                  <StepTitle>Add Components</StepTitle>
                  <StepDescription>Define inputs, commands, and alert actions</StepDescription>
                </StepCard>
                <StepCard>
                  <StepNumber>3</StepNumber>
                  <StepIconWrapper><Lightning /></StepIconWrapper>
                  <StepTitle>Generate</StepTitle>
                  <StepDescription>Build your complete UCC app structure</StepDescription>
                </StepCard>
                <StepCard>
                  <StepNumber>4</StepNumber>
                  <StepIconWrapper><FileZip /></StepIconWrapper>
                  <StepTitle>Download</StepTitle>
                  <StepDescription>Get a ready-to-install Splunk package</StepDescription>
                </StepCard>
              </StepsContainer>
            </HowItWorksSection>

            <FeaturesGrid>
              <FeatureItem>
                <FeatureIcon><Checkmark /></FeatureIcon>
                <FeatureText><strong>Source Tracking</strong>Identifies which files are source vs generated</FeatureText>
              </FeatureItem>
              <FeatureItem>
                <FeatureIcon><Checkmark /></FeatureIcon>
                <FeatureText><strong>CI/CD Ready</strong>Export only source files for version control</FeatureText>
              </FeatureItem>
              <FeatureItem>
                <FeatureIcon><Checkmark /></FeatureIcon>
                <FeatureText><strong>UCC Framework</strong>Generates valid globalConfig.json</FeatureText>
              </FeatureItem>
              <FeatureItem>
                <FeatureIcon><Checkmark /></FeatureIcon>
                <FeatureText><strong>ZIP Packaging</strong>Download ready-to-install Splunk apps</FeatureText>
              </FeatureItem>
              <FeatureItem>
                <FeatureIcon><Checkmark /></FeatureIcon>
                <FeatureText><strong>Auto-Save</strong>Your progress is automatically saved</FeatureText>
              </FeatureItem>
            </FeaturesGrid>

            {generated && (
              <div style={{ marginTop: 24 }}>
                <Message type="info">
                  You have a project in progress. Click &quot;Files&quot; to continue editing.
                </Message>
              </div>
            )}
          </WelcomeContainer>
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

        {mode === 'paste-config' && (
          <PasteConfigPanel
            onLoad={handlePasteConfigLoad}
            onCancel={() => setMode('welcome')}
          />
        )}

        {mode === 'getting-started' && <GettingStartedPage />}

        {mode === 'files' && generated && (() => {
          const root = vfs.getRoot();
          const firstDir = Array.from(root.children.values()).find((n) => n.type === 'directory');
          const vfsAppId = firstDir?.name ?? '';
          const appId =
            wizardState.metadata.appId ||
            (wizardState.metadata.name && wizardState.metadata.name.toLowerCase().replace(/[^a-z0-9]/g, '_')) ||
            vfsAppId ||
            'app';
          return (
          <FilesView>
            <BuildPanel
              files={root}
              appId={appId}
              onFixItRequest={(prompt) => {
                setPendingFixItPrompt(prompt);
                setChatOpen(true);
              }}
            />
            <FileBrowser
              key={`filebrowser-${vfsVersion}`}
              vfs={vfs}
              developerMode={developerMode}
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
          </FilesView>
          );
        })()}
      </Main>

      {/* GitHub Modal */}
      <Modal open={showGitHubModal} onRequestClose={() => { setShowGitHubModal(false); setGitHubImportMode(false); }} style={{ width: '800px', maxWidth: '90%' }} returnFocus={modalReturnRef}>
        <Modal.Header title={gitHubImportMode ? 'Import from GitHub' : 'GitHub Integration'} />
        <Modal.Body>
          <GitHubPanel 
            session={gitHubSession} 
            onSessionUpdate={setGitHubSession} 
            vfs={vfs} 
            appName={appName}
            mode={gitHubImportMode ? 'import' : 'push'}
            onImportComplete={() => {
              setShowGitHubModal(false);
              setGenerated(true);
              setMode('files');
            }}
            onRequestClose={() => { setShowGitHubModal(false); setGitHubImportMode(false); }}
          />
        </Modal.Body>
      </Modal>

      <AIChatPanel
        // key forces a full remount on "Start Fresh" so chat messages,
        // planText, todos, decisions, and any in-flight SSE stream are
        // dropped along with the rest of the project state.
        key={chatResetKey}
        open={chatOpen}
        onRequestClose={() => setChatOpen(false)}
        vfs={vfs}
        onBuildTrigger={handleGenerate}
        externalPrompt={pendingFixItPrompt}
        onExternalPromptConsumed={() => setPendingFixItPrompt(null)}
        onVfsChange={() => setVfsVersion(v => v + 1)}
        context={{
          globalConfig: vfs.readFile('globalConfig.json') ?? undefined,
          appName: appName,
        }}
      />
    </AppContainer>
  );
}

export default App;
