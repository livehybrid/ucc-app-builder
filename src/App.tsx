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
import { Wizard } from './components/Wizard';
import { FileBrowser } from './components/FileBrowser';
import { ImportExport } from './components/ImportExport';
import { BuildPanel } from './components/BuildPanel';
import { AIChatPanel } from './components/AIChatPanel';
import { ConfigPreview } from './components/ConfigPreview';
import { LoopPanel } from './components/LoopPanel';
import { GitHubPanel } from './components/GitHubPanel';
import type { GitHubSession } from './types/github';
import Modal from '@splunk/react-ui/Modal';
import { VirtualFileSystem } from './lib/vfs';
import { generateSplunkApp } from './lib/generator';
import { downloadAppAsZip } from './lib/packager';
import { loadImportToVFS } from './lib/importer';
import {
  saveState,
  loadState,
  clearState,
  saveVFS,
  loadVFS,
  hasSavedState,
} from './lib/persistence';
import type { WizardState, ImportAnalysis } from './types';
import { DEFAULT_WIZARD_STATE } from './types';

type AppMode = 'welcome' | 'wizard' | 'import' | 'files' | 'loop';

const AppContainer = styled.div`
  /* Fill the mount point (#root), not the viewport. Standalone: html/body/#root are
     height:100% so this equals the viewport. Embedded in a Splunk dashboard the SPA is
     mounted at a vertical offset below the app chrome; ui_loader.js sizes #root to the
     remaining visible height, so 100% keeps the whole shell — including the Monaco
     editor — on-screen and scrollable. Using 100vh here pushed the editor below the
     fold where, with overflow:hidden, its lower content was unreachable. */
  height: 100%;
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
  background: linear-gradient(135deg, #65a637, #8bc34a);
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
    background: linear-gradient(90deg, #65a637, #a2d964);
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
    border-color: #65a637;
    box-shadow: 0 8px 32px rgba(101, 166, 55, 0.15);
  }

  &::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 4px;
    background: linear-gradient(90deg, #65a637, #8bc34a);
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
  color: #65a637;

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
  color: #65a637;
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
  background: linear-gradient(135deg, #65a637, #8bc34a);
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
  color: #65a637;

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
  color: #65a637;
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
  const [showPreview, setShowPreview] = useState(false);
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
    // Tell the AI panel to clear too: chat history, agent session memory,
    // session approvals. Otherwise the old conversation steers the agent back
    // to the apps we just cleared.
    window.dispatchEvent(new Event('ucc:fresh-start'));
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
  }, [mode, wizardState, appName, generated, developerMode, gitHubSession, vfs]);

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

  const handleImportComplete = useCallback(
    (analysis: ImportAnalysis) => {
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
        },
      }));
      setGenerated(true);
      setMode('files');
    },
    [vfs]
  );

  const handleReset = useCallback(() => {
    if (confirm('Are you sure you want to start over? All progress will be lost.')) {
      handleStartFresh();
    }
  }, [handleStartFresh]);

  // Starting a NEW app while previous work is still in the (persisted) VFS:
  // offer a clean slate. Without this, earlier app attempts leak into the next
  // session — the agent's list_files sees them and "helpfully" edits an old app.
  const offerFreshStart = useCallback(() => {
    if (vfs.listAllFiles().length === 0) return;
    if (
      confirm(
        'You have app files from a previous session. Clear them and start fresh?\n\n' +
          'OK = clear everything and start a new app. Cancel = keep them and continue editing.'
      )
    ) {
      handleStartFresh();
    }
  }, [vfs, handleStartFresh]);

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
              offerFreshStart();
              setMode('wizard');
            }}
            label="New App"
          />
          <Button
            appearance={mode === 'import' ? 'primary' : 'default'}
            onClick={() => setMode('import')}
            label="Import"
          />
          <Button
            appearance={chatOpen ? 'primary' : 'default'}
            onClick={() => setChatOpen(!chatOpen)}
            label="AI Agent"
            icon={<Lightning />}
          />
          <Button
            appearance={mode === 'loop' ? 'primary' : 'default'}
            onClick={() => setMode('loop')}
            label="Validate (AppInspect)"
            title="Build the current app with ucc-gen and run Splunk AppInspect on it, auto-fixing findings until clean. Works on anything in the editor — new, imported, or mid-edit."
          />
          <Button
            appearance={mode === 'files' ? 'primary' : 'default'}
            onClick={() => setMode('files')}
            disabled={!generated}
            label="Files"
          />
          <Button
            appearance={showPreview ? 'primary' : 'default'}
            onClick={() => setShowPreview(true)}
            disabled={!generated}
            label="Preview UI"
            title="Render globalConfig.json as the built app's UI — tabs, input forms and live validators — without running a build."
          />
          <Button
            appearance={gitHubSession ? 'primary' : 'default'}
            onClick={() => setShowGitHubModal(true)}
            label="GitHub"
            icon={<Rocket />}
          />
          <Button
            appearance={developerMode ? 'primary' : 'default'}
            onClick={() => setDeveloperMode(!developerMode)}
            label={developerMode ? 'All Files: ON' : 'All Files: OFF'}
            title="OFF: the file tree shows only files meant to be edited (your files, helpers, lib/, static/, globalConfig.json, app.manifest). ON: also show the ucc-gen-generated boilerplate."
            style={{ minWidth: 120 }}
          />
          {generated && (
            <>
              <Button
                appearance="primary"
                onClick={handleDownload}
                label="Download ZIP"
                title="Zip of every file in the tree exactly as shown (raw snapshot, including generated files when present)."
              />
              <Button
                appearance="default"
                onClick={async () => {
                  const { exportSourceZipFromVFS } = await import('./lib/exporter');
                  const { downloadBlob } = await import('./lib/packager');
                  const blob = await exportSourceZipFromVFS(vfs, appName);
                  downloadBlob(blob, `${appName}-source.zip`);
                }}
                label="Download Source"
                title="Normalized UCC source project (globalConfig.json + package/) — what you'd commit to git and build with ucc-gen."
                icon={<FileZip />}
              />
              <Button appearance="destructive" onClick={handleReset} label="Reset" />
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
                Describe an add-on and a tool-calling AI agent builds it, grounds it in your live
                Splunk via MCP, then inspects and self-corrects until it is AppInspect-clean. Or
                build it by hand with the wizard.
              </Tagline>
            </WelcomeIntro>

            <ChoiceCardsContainer>
              <ChoiceCard
                onClick={() => {
                  offerFreshStart();
                  if (!generated) setMode('wizard');
                  setChatOpen(true);
                }}
              >
                <CardIconWrapper>
                  <Lightning />
                </CardIconWrapper>
                <CardTitle>Build with the AI Agent</CardTitle>
                <CardSubtitle>Chat → grounded → inspected → clean</CardSubtitle>
                <CardDescription>
                  Describe what you need. The agent edits files, grounds the design in live Splunk
                  indexes/sourcetypes (MCP), and runs build → AppInspect → self-correct until the
                  package is clean.
                </CardDescription>
              </ChoiceCard>

              <ChoiceCard
                onClick={() => {
                  offerFreshStart();
                  setMode('wizard');
                }}
              >
                <CardIconWrapper>
                  <Rocket />
                </CardIconWrapper>
                <CardTitle>Create New App</CardTitle>
                <CardSubtitle>Build from scratch</CardSubtitle>
                <CardDescription>
                  Use the wizard to build a new Splunk app from scratch with guided steps.
                </CardDescription>
              </ChoiceCard>

              <ChoiceCard onClick={() => setMode('import')}>
                <CardIconWrapper>
                  <ArrowCircleInRight />
                </CardIconWrapper>
                <CardTitle>Import Existing App</CardTitle>
                <CardSubtitle>Extract source files</CardSubtitle>
                <CardDescription>
                  Import an existing app to extract source files for version control and CI/CD.
                </CardDescription>
              </ChoiceCard>

              <ChoiceCard
                onClick={() => {
                  setGitHubImportMode(true);
                  setShowGitHubModal(true);
                }}
              >
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
                  <StepIconWrapper>
                    <Cog />
                  </StepIconWrapper>
                  <StepTitle>Configure</StepTitle>
                  <StepDescription>Set up app details, branding, and metadata</StepDescription>
                </StepCard>
                <StepCard>
                  <StepNumber>2</StepNumber>
                  <StepIconWrapper>
                    <PuzzlePiece />
                  </StepIconWrapper>
                  <StepTitle>Add Components</StepTitle>
                  <StepDescription>Define inputs, commands, and alert actions</StepDescription>
                </StepCard>
                <StepCard>
                  <StepNumber>3</StepNumber>
                  <StepIconWrapper>
                    <Lightning />
                  </StepIconWrapper>
                  <StepTitle>Generate</StepTitle>
                  <StepDescription>Build your complete UCC app structure</StepDescription>
                </StepCard>
                <StepCard>
                  <StepNumber>4</StepNumber>
                  <StepIconWrapper>
                    <FileZip />
                  </StepIconWrapper>
                  <StepTitle>Download</StepTitle>
                  <StepDescription>Get a ready-to-install Splunk package</StepDescription>
                </StepCard>
              </StepsContainer>
            </HowItWorksSection>

            <FeaturesGrid>
              <FeatureItem>
                <FeatureIcon>
                  <Checkmark />
                </FeatureIcon>
                <FeatureText>
                  <strong>Source Tracking</strong>Identifies which files are source vs generated
                </FeatureText>
              </FeatureItem>
              <FeatureItem>
                <FeatureIcon>
                  <Checkmark />
                </FeatureIcon>
                <FeatureText>
                  <strong>CI/CD Ready</strong>Export only source files for version control
                </FeatureText>
              </FeatureItem>
              <FeatureItem>
                <FeatureIcon>
                  <Checkmark />
                </FeatureIcon>
                <FeatureText>
                  <strong>UCC Framework</strong>Generates valid globalConfig.json
                </FeatureText>
              </FeatureItem>
              <FeatureItem>
                <FeatureIcon>
                  <Checkmark />
                </FeatureIcon>
                <FeatureText>
                  <strong>ZIP Packaging</strong>Download ready-to-install Splunk apps
                </FeatureText>
              </FeatureItem>
              <FeatureItem>
                <FeatureIcon>
                  <Checkmark />
                </FeatureIcon>
                <FeatureText>
                  <strong>Auto-Save</strong>Your progress is automatically saved
                </FeatureText>
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
          <Wizard state={wizardState} onChange={setWizardState} onGenerate={handleGenerate} />
        )}

        {mode === 'import' && <ImportExport onImportComplete={handleImportComplete} />}

        {mode === 'loop' && <LoopPanel />}

        {mode === 'files' &&
          generated &&
          (() => {
            const root = vfs.getRoot();
            const firstDir = Array.from(root.children.values()).find((n) => n.type === 'directory');
            const vfsAppId = firstDir?.name ?? '';
            const appId =
              wizardState.metadata.appId ||
              (wizardState.metadata.name &&
                wizardState.metadata.name.toLowerCase().replace(/[^a-z0-9]/g, '_')) ||
              vfsAppId ||
              'app';
            return (
              <FilesView>
                <BuildPanel files={root} appId={appId} />
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
      <Modal
        open={showGitHubModal}
        onRequestClose={() => {
          setShowGitHubModal(false);
          setGitHubImportMode(false);
        }}
        style={{ width: '800px', maxWidth: '90%' }}
        returnFocus={modalReturnRef}
      >
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
            onRequestClose={() => {
              setShowGitHubModal(false);
              setGitHubImportMode(false);
            }}
          />
        </Modal.Body>
      </Modal>

      {/* globalConfig UI Preview — see and test the generated UI pre-build */}
      <Modal
        open={showPreview}
        onRequestClose={() => setShowPreview(false)}
        style={{ width: '92vw', maxWidth: '1100px' }}
        returnFocus={modalReturnRef}
      >
        <Modal.Header title="UI Preview — as ucc-gen will build it" />
        <Modal.Body style={{ maxHeight: '78vh', overflowY: 'auto' }}>
          {showPreview && (
            <ConfigPreview
              key={vfsVersion}
              configJson={
                vfs.getAllFiles().find((f) => f.path.endsWith('globalConfig.json'))?.content ?? null
              }
            />
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button appearance="primary" onClick={() => setShowPreview(false)} label="Close" />
        </Modal.Footer>
      </Modal>

      <AIChatPanel
        open={chatOpen}
        onRequestClose={() => setChatOpen(false)}
        vfs={vfs}
        onBuildTrigger={handleGenerate}
        onVfsChange={() => {
          setVfsVersion((v) => v + 1);
          // The agent just wrote files. If the user is still on the welcome or
          // wizard screen, take them to the editor so they can watch the app
          // take shape instead of staring at the start page.
          if (vfs.getAllFiles().length > 0) {
            setGenerated(true);
            setMode((m) => (m === 'welcome' || m === 'wizard' ? 'files' : m));
          }
        }}
        context={{
          globalConfig: vfs.readFile('globalConfig.json') ?? undefined,
          appName: appName,
        }}
      />
    </AppContainer>
  );
}

export default App;
