import styled from 'styled-components';
import { variables } from '@splunk/themes';
import Heading from '@splunk/react-ui/Heading';

// ── Layout shells ──────────────────────────────────────────────────────────

const Page = styled.div`
  max-width: 960px;
  margin: 0 auto;
  padding: 40px 32px 80px;
  color: ${variables.contentColorDefault};
  font-size: 0.95rem;
  line-height: 1.65;
`;

const Hero = styled.div`
  text-align: center;
  margin-bottom: 56px;
  padding: 48px 32px;
  background: linear-gradient(135deg, rgba(82, 168, 236, 0.08) 0%, rgba(101, 166, 55, 0.08) 100%);
  border-radius: 12px;
  border: 1px solid ${variables.borderColor};
`;

const HeroBadge = styled.div`
  display: inline-block;
  background: rgba(101, 166, 55, 0.15);
  color: #65A637;
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 4px 12px;
  border-radius: 20px;
  margin-bottom: 16px;
`;

const HeroTitle = styled.h1`
  font-size: 2rem;
  font-weight: 700;
  margin: 0 0 12px;
  color: ${variables.contentColorDefault};
`;

const HeroSub = styled.p`
  font-size: 1.05rem;
  color: ${'#9b9ea3'};
  max-width: 600px;
  margin: 0 auto;
`;

const TocGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 10px;
  margin: 32px 0 56px;
`;

const TocItem = styled.a`
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: rgba(255,255,255,0.04);
  border: 1px solid ${variables.borderColor};
  border-radius: 8px;
  color: ${variables.contentColorDefault};
  text-decoration: none;
  font-size: 0.85rem;
  font-weight: 500;
  transition: background 0.15s;
  &:hover { background: rgba(82, 168, 236, 0.1); border-color: #52A8EC; }
`;

const TocEmoji = styled.span`
  font-size: 1.1rem;
  flex-shrink: 0;
`;

const Section = styled.section`
  margin-bottom: 64px;
  scroll-margin-top: 80px;
`;

const SectionHeader = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
  padding-bottom: 12px;
  border-bottom: 2px solid ${variables.borderColor};
`;

const SectionEmoji = styled.span`
  font-size: 1.6rem;
`;

const SectionTitle = styled.h2`
  font-size: 1.35rem;
  font-weight: 700;
  margin: 0;
  color: ${variables.contentColorDefault};
`;

const SectionIntro = styled.p`
  color: ${'#9b9ea3'};
  margin: 0 0 24px;
`;

// ── Media placeholders ──────────────────────────────────────────────────────

const MediaSlot = styled.div<{ $tall?: boolean }>`
  width: 100%;
  height: ${({ $tall }) => ($tall ? '420px' : '280px')};
  background: rgba(255, 255, 255, 0.03);
  border: 2px dashed ${variables.borderColor};
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin: 20px 0;
  color: ${'#9b9ea3'};
  font-size: 0.85rem;
  text-align: center;
  padding: 16px;
`;

const MediaLabel = styled.div`
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: ${'#9b9ea3'};
  opacity: 0.6;
`;

const MediaHint = styled.div`
  font-size: 0.8rem;
  color: ${'#9b9ea3'};
  opacity: 0.5;
  max-width: 300px;
  text-align: center;
`;

interface PlaceholderProps {
  label: string;
  hint?: string;
  tall?: boolean;
  isVideo?: boolean;
}

function Placeholder({ label, hint, tall, isVideo }: PlaceholderProps) {
  return (
    <MediaSlot $tall={tall}>
      <div style={{ fontSize: '2rem' }}>{isVideo ? '▶️' : '📸'}</div>
      <MediaLabel>{isVideo ? 'Video' : 'Screenshot'}: {label}</MediaLabel>
      {hint && <MediaHint>{hint}</MediaHint>}
    </MediaSlot>
  );
}

// ── Feature cards ───────────────────────────────────────────────────────────

const CardGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 16px;
  margin: 20px 0;
`;

const FeatureCard = styled.div`
  padding: 18px;
  background: rgba(255,255,255,0.03);
  border: 1px solid ${variables.borderColor};
  border-radius: 8px;
`;

const CardIcon = styled.div`
  font-size: 1.5rem;
  margin-bottom: 8px;
`;

const CardTitle = styled.div`
  font-weight: 700;
  font-size: 0.9rem;
  margin-bottom: 6px;
`;

const CardBody = styled.div`
  font-size: 0.82rem;
  color: ${'#9b9ea3'};
  line-height: 1.55;
`;

interface FeatureCardProps { icon: string; title: string; body: string }
function FCard({ icon, title, body }: FeatureCardProps) {
  return (
    <FeatureCard>
      <CardIcon>{icon}</CardIcon>
      <CardTitle>{title}</CardTitle>
      <CardBody>{body}</CardBody>
    </FeatureCard>
  );
}

// ── Step list ───────────────────────────────────────────────────────────────

const StepList = styled.ol`
  padding-left: 0;
  list-style: none;
  counter-reset: step;
  display: flex;
  flex-direction: column;
  gap: 16px;
`;

const StepItem = styled.li`
  counter-increment: step;
  display: flex;
  gap: 16px;
  align-items: flex-start;
  &::before {
    content: counter(step);
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    background: rgba(82, 168, 236, 0.15);
    color: #52A8EC;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 0.8rem;
    margin-top: 2px;
  }
`;

const StepContent = styled.div`
  flex: 1;
  font-size: 0.88rem;
`;

const StepTitle = styled.strong`
  display: block;
  margin-bottom: 2px;
`;

// ── Tag pills ───────────────────────────────────────────────────────────────

const Tags = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 12px 0;
`;

const Tag = styled.span<{ $variant?: 'green' | 'red' | 'blue' | 'orange' }>`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: 20px;
  font-size: 0.75rem;
  font-weight: 600;
  background: ${({ $variant }) =>
    $variant === 'green' ? 'rgba(101,166,55,0.15)'
    : $variant === 'red' ? 'rgba(211,47,47,0.15)'
    : $variant === 'orange' ? 'rgba(230,81,0,0.15)'
    : 'rgba(82,168,236,0.15)'};
  color: ${({ $variant }) =>
    $variant === 'green' ? '#65A637'
    : $variant === 'red' ? '#D32F2F'
    : $variant === 'orange' ? '#E65100'
    : '#52A8EC'};
`;

// ── Note / callout ──────────────────────────────────────────────────────────

const Note = styled.div<{ $variant?: 'info' | 'warning' | 'tip' }>`
  padding: 14px 18px;
  border-radius: 6px;
  border-left: 3px solid ${({ $variant }) =>
    $variant === 'warning' ? '#E65100'
    : $variant === 'tip' ? '#65A637'
    : '#52A8EC'};
  background: ${({ $variant }) =>
    $variant === 'warning' ? 'rgba(230,81,0,0.08)'
    : $variant === 'tip' ? 'rgba(101,166,55,0.08)'
    : 'rgba(82,168,236,0.08)'};
  font-size: 0.85rem;
  color: ${'#9b9ea3'};
  margin: 16px 0;
  line-height: 1.6;
  strong { color: ${variables.contentColorDefault}; }
`;

const TwoCol = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
  margin: 16px 0;
  @media (max-width: 600px) { grid-template-columns: 1fr; }
`;

const DoBox = styled.div<{ $positive?: boolean }>`
  padding: 16px;
  border-radius: 8px;
  border: 1px solid ${({ $positive }) => ($positive ? 'rgba(101,166,55,0.3)' : 'rgba(211,47,47,0.3)')};
  background: ${({ $positive }) => ($positive ? 'rgba(101,166,55,0.05)' : 'rgba(211,47,47,0.05)')};
`;

const DoTitle = styled.div<{ $positive?: boolean }>`
  font-weight: 700;
  font-size: 0.85rem;
  color: ${({ $positive }) => ($positive ? '#65A637' : '#D32F2F')};
  margin-bottom: 10px;
  display: flex;
  align-items: center;
  gap: 6px;
`;

const DoList = styled.ul`
  margin: 0;
  padding-left: 18px;
  font-size: 0.82rem;
  color: ${'#9b9ea3'};
  line-height: 1.7;
`;

const Kbd = styled.kbd`
  display: inline-block;
  padding: 2px 6px;
  background: rgba(255,255,255,0.08);
  border: 1px solid ${variables.borderColor};
  border-radius: 4px;
  font-family: 'Splunk Platform Mono', monospace;
  font-size: 0.78rem;
`;

const InlineCode = styled.code`
  background: rgba(255,255,255,0.08);
  padding: 1px 5px;
  border-radius: 3px;
  font-family: 'Splunk Platform Mono', monospace;
  font-size: 0.82rem;
`;

// ─────────────────────────────────────────────────────────────────────────────

export function GettingStartedPage() {
  return (
    <Page>
      {/* Hero */}
      <Hero>
        <HeroBadge>Getting Started Guide</HeroBadge>
        <HeroTitle>Splunk App Builder</HeroTitle>
        <HeroSub>
          Everything you need to build, edit, and certify Splunk UCC add-ons — from a guided wizard to an AI-powered coding assistant.
        </HeroSub>
      </Hero>

      {/* Table of contents */}
      <TocGrid>
        {[
          ['🏠', 'Home & Navigation', '#home'],
          ['🧙', 'App Wizard', '#wizard'],
          ['📁', 'File Editor', '#files'],
          ['🏗️', 'Build & Package', '#build'],
          ['🤖', 'AI Assistant', '#ai'],
          ['🔍', 'AppInspect', '#appinspect'],
          ['🐙', 'GitHub', '#github'],
          ['📦', 'Import / Export', '#import'],
          ['⚙️', 'Dev Mode', '#devmode'],
        ].map(([emoji, label, href]) => (
          <TocItem key={href} href={href}>
            <TocEmoji>{emoji}</TocEmoji>
            {label}
          </TocItem>
        ))}
      </TocGrid>

      {/* ── 1. Home ─────────────────────────────────────────────────────── */}
      <Section id="home">
        <SectionHeader>
          <SectionEmoji>🏠</SectionEmoji>
          <SectionTitle>Home &amp; Navigation</SectionTitle>
        </SectionHeader>
        <SectionIntro>
          The home screen is your starting point. From here you can create, open, or import a Splunk app.
        </SectionIntro>

        <Placeholder
          label="Home screen — choice cards and navigation bar"
          hint="Replace with a full-width screenshot of the welcome page"
        />

        <Heading level={4}>Navigation bar</Heading>
        <CardGrid>
          <FCard icon="🏠" title="Home" body="Return to this welcome screen from anywhere in the app." />
          <FCard icon="✨" title="New App" body="Start the guided wizard to create a brand-new Splunk add-on from scratch." />
          <FCard icon="📦" title="Import" body="Load an existing app package (.zip, .tgz, .spl) or source ZIP to continue working on it." />
          <FCard icon="📁" title="Files" body="Open the file editor for the currently loaded project. Disabled until a project is loaded." />
          <FCard icon="🤖" title="AI Assistant" body="Open the AI chat panel for the current project. Appears only when a project is loaded." />
          <FCard icon="🐙" title="GitHub" body="Push to or import from a GitHub repository using device-flow OAuth (no password needed)." />
          <FCard icon="⬇️" title="Download App" body="Build and download the fully compiled, installable Splunk app (.zip). Appears when a project is ready." />
          <FCard icon="📤" title="Export Source" body="Download source files only (without generated output). Use for version control and CI/CD pipelines." />
          <FCard icon="⚙️" title="Dev Mode" body="Toggle visibility of auto-generated files in the file tree. Off by default — see the Dev Mode section." />
          <FCard icon="🔄" title="Reset" body="Discard the current project and return to a clean slate. Cannot be undone." />
        </CardGrid>

        <Note $variant="tip">
          <strong>Your work is saved automatically.</strong> The wizard state, file edits, and chat history are persisted to your browser's local storage. Refreshing the page picks up where you left off.
        </Note>
      </Section>

      {/* ── 2. Wizard ───────────────────────────────────────────────────── */}
      <Section id="wizard">
        <SectionHeader>
          <SectionEmoji>🧙</SectionEmoji>
          <SectionTitle>App Wizard</SectionTitle>
        </SectionHeader>
        <SectionIntro>
          The wizard walks you through four steps to configure a complete UCC-based Splunk add-on. Each step auto-generates the relevant config files.
        </SectionIntro>

        <Placeholder label="Wizard — Step 1: App Details" hint="Screenshot showing the details form with app name, version, author fields" />

        <StepList>
          <StepItem>
            <StepContent>
              <StepTitle>Step 1 — App Details</StepTitle>
              Set the app ID, display name, version, author, and description. The app ID becomes the folder name inside Splunk and must be lowercase with underscores only. This generates <InlineCode>app.conf</InlineCode> and <InlineCode>app.manifest</InlineCode>.
            </StepContent>
          </StepItem>
          <StepItem>
            <StepContent>
              <StepTitle>Step 2 — Branding</StepTitle>
              Upload a logo/icon. The builder auto-resizes your image to all four required Splunk icon sizes (36×36, 72×72, etc.) and stores them in <InlineCode>static/</InlineCode>. You can also set a custom theme colour.
            </StepContent>
          </StepItem>
          <StepItem>
            <StepContent>
              <StepTitle>Step 3 — Components</StepTitle>
              Add the functional building blocks of your add-on. You can add multiple of each type:
            </StepContent>
          </StepItem>
        </StepList>

        <CardGrid style={{ marginLeft: 44, marginTop: 8 }}>
          <FCard icon="⚡" title="Modular Inputs" body="Define data collection inputs. Each input gets its own Python handler, stanza in inputs.conf, and entity fields (API keys, URLs, intervals, index selector)." />
          <FCard icon="🔔" title="Alert Actions" body="Custom actions triggered by Splunk alerts. Configure entity fields, icon, and generates a Python action handler." />
          <FCard icon="🔧" title="Custom Commands" body="SPL search commands (streaming, reporting, generating). Generates a Python command script and commands.conf entry." />
          <FCard icon="🔑" title="API Credentials" body="Credential accounts (Basic, OAuth 2.0, API Key). These become the Accounts tab in the add-on's configuration UI." />
          <FCard icon="🌐" title="REST Endpoints" body="Custom REST handler classes with configurable HTTP methods and authentication settings." />
        </CardGrid>

        <StepList style={{ marginTop: 16 }}>
          <StepItem>
            <StepContent>
              <StepTitle>Step 4 — Review &amp; Generate</StepTitle>
              Preview the complete <InlineCode>globalConfig.json</InlineCode> that will be generated, then click <strong>Generate App</strong> to create all files and move to the file editor.
            </StepContent>
          </StepItem>
        </StepList>

        <Placeholder label="Wizard — Step 3: Components (adding a modular input)" hint="Screenshot showing the add input form with entity fields" />

        <Note $variant="info">
          <strong>Tip:</strong> You can come back to the wizard by clicking the component name in the file editor to re-open its configuration panel. The wizard and file editor stay in sync — edits to <InlineCode>globalConfig.json</InlineCode> in the editor are reflected in the wizard view.
        </Note>
      </Section>

      {/* ── 3. File Editor ──────────────────────────────────────────────── */}
      <Section id="files">
        <SectionHeader>
          <SectionEmoji>📁</SectionEmoji>
          <SectionTitle>File Editor</SectionTitle>
        </SectionHeader>
        <SectionIntro>
          The Files view is where you do the bulk of your editing. It combines a full Monaco-powered code editor with a virtual file system (VFS) that lives in your browser.
        </SectionIntro>

        <Placeholder label="Files view — file tree on left, Monaco editor on right" hint="Full screenshot showing tree, editor, and build panel" tall />

        <Heading level={4}>File tree</Heading>
        <ul style={{ color: '#9b9ea3', fontSize: '0.88rem', lineHeight: 1.8 }}>
          <li><strong>Left-click</strong> a file to open it in the editor.</li>
          <li><strong>Right-click</strong> for a context menu: New File, New Folder, Rename, Duplicate, Delete.</li>
          <li>Files with <strong>unsaved changes</strong> show a dot indicator next to their name.</li>
          <li>The tree only shows editable source files by default. Enable <strong>Dev Mode</strong> to see all generated files.</li>
        </ul>

        <Heading level={4}>Monaco editor features</Heading>
        <CardGrid>
          <FCard icon="✅" title="globalConfig.json validation" body="Validated live against the official UCC JSON schema. Red underlines show schema violations. Hover for details." />
          <FCard icon="🎨" title="Syntax highlighting" body="Full highlighting for Python (.py), JSON (.json), Splunk conf (.conf), and XML (.xml)." />
          <FCard icon="💡" title="Conf file autocomplete" body="Type inside any .conf file to get stanza name suggestions and parameter completions drawn from the official Splunk spec files. Press Ctrl+Space to trigger manually." />
          <FCard icon="🐍" title="Python snippets" body="UCC-specific Python snippets (stream_events helper, collect_events class) available via Ctrl+Space in .py files." />
          <FCard icon="💾" title="Save" body="Press Ctrl+S (or Cmd+S on Mac) to save the current file to the VFS." />
          <FCard icon="🖼️" title="Image preview" body="PNG icon files are displayed as image previews rather than binary content." />
        </CardGrid>

        <Note $variant="tip">
          <strong>Conf file autocomplete:</strong> Open any <InlineCode>.conf</InlineCode> file (e.g. <InlineCode>props.conf</InlineCode>, <InlineCode>transforms.conf</InlineCode>). Start a new line inside a stanza and begin typing a parameter name — suggestions appear automatically. After typing <InlineCode>=</InlineCode>, enum values from the spec are offered (e.g. <InlineCode>KV_MODE</InlineCode> shows <InlineCode>auto | none | multi | json | xml</InlineCode>).
        </Note>
      </Section>

      {/* ── 4. Build ────────────────────────────────────────────────────── */}
      <Section id="build">
        <SectionHeader>
          <SectionEmoji>🏗️</SectionEmoji>
          <SectionTitle>Build &amp; Package</SectionTitle>
        </SectionHeader>
        <SectionIntro>
          The Build panel sits above the file tree and turns your source files into a real, installable Splunk add-on using <InlineCode>ucc-gen</InlineCode> on the backend.
        </SectionIntro>

        <Placeholder label="Build panel — showing build logs and download button" hint="Screenshot after a successful build with logs visible" />

        <StepList>
          <StepItem>
            <StepContent>
              <StepTitle>Build App</StepTitle>
              Sends all VFS files to the backend, runs <InlineCode>ucc-gen build</InlineCode>, streams the build logs in real time, and stores the compiled <InlineCode>.tgz</InlineCode> package ready for download.
            </StepContent>
          </StepItem>
          <StepItem>
            <StepContent>
              <StepTitle>Download Built App</StepTitle>
              Appears after a successful build. Downloads the compiled <InlineCode>.tgz</InlineCode> — ready to install directly in Splunk or upload to SplunkBase.
            </StepContent>
          </StepItem>
          <StepItem>
            <StepContent>
              <StepTitle>Download App (nav bar)</StepTitle>
              Quick-access version of the same download from the top navigation bar.
            </StepContent>
          </StepItem>
          <StepItem>
            <StepContent>
              <StepTitle>Export Source (nav bar)</StepTitle>
              Downloads a <InlineCode>.zip</InlineCode> of source files only (no generated output). Use this to commit to Git or feed into a CI/CD pipeline that runs <InlineCode>ucc-gen</InlineCode> itself.
            </StepContent>
          </StepItem>
        </StepList>

        <Note $variant="warning">
          <strong>Backend required:</strong> Building requires the Node.js backend server running (<InlineCode>npm run dev:server</InlineCode>). The backend status indicator in the build panel shows whether it is reachable and whether <InlineCode>ucc-gen</InlineCode> is installed.
        </Note>
      </Section>

      {/* ── 5. AI Assistant ─────────────────────────────────────────────── */}
      <Section id="ai">
        <SectionHeader>
          <SectionEmoji>🤖</SectionEmoji>
          <SectionTitle>AI Assistant</SectionTitle>
        </SectionHeader>
        <SectionIntro>
          The AI Assistant is the most powerful feature in Splunk App Builder. It is a specialized coding agent that understands the UCC framework, Splunk's conf file system, and Python modular input patterns. It can read and write every file in your project, build the app, and suggest next steps — all through natural language.
        </SectionIntro>

        <Placeholder
          label="AI Assistant — full chat panel with suggested action buttons"
          hint="Screenshot showing a conversation, tool call bubbles, and the suggested action buttons below the chat"
          tall
          isVideo
        />

        <Heading level={4}>What the AI can do</Heading>
        <Tags>
          <Tag $variant="green">✓ Write Python modular inputs</Tag>
          <Tag $variant="green">✓ Edit globalConfig.json</Tag>
          <Tag $variant="green">✓ Create helper modules</Tag>
          <Tag $variant="green">✓ Write alert actions &amp; custom commands</Tag>
          <Tag $variant="green">✓ Read and write any file in the project</Tag>
          <Tag $variant="green">✓ Build the app &amp; fix build errors</Tag>
          <Tag $variant="green">✓ Reference Splunk .conf specs</Tag>
          <Tag $variant="green">✓ Validate Python syntax before writing</Tag>
          <Tag $variant="green">✓ Checkpoint &amp; restore your project state</Tag>
          <Tag $variant="green">✓ Suggest and explain next steps</Tag>
          <Tag $variant="green">✓ Add transforms.conf, props.conf, lookup files</Tag>
          <Tag $variant="green">✓ Fix AppInspect failures (via Fix it button)</Tag>
        </Tags>

        <Placeholder label="AI writing a modular input Python file" hint="Screenshot showing the AI tool call expanding to show a write_file call with Python content" />

        <Heading level={4}>What the AI cannot do</Heading>
        <Tags>
          <Tag $variant="red">✗ Access external URLs or the internet</Tag>
          <Tag $variant="red">✗ Connect to your Splunk instance</Tag>
          <Tag $variant="red">✗ Run or test the app live</Tag>
          <Tag $variant="red">✗ Access files outside your project's VFS</Tag>
          <Tag $variant="red">✗ Execute arbitrary shell commands</Tag>
          <Tag $variant="red">✗ Store API keys or passwords in plain text</Tag>
          <Tag $variant="red">✗ Help with non-Splunk topics</Tag>
        </Tags>

        <Note $variant="warning">
          <strong>Sensitive credentials:</strong> The AI is designed to <em>never</em> store API keys, passwords, or tokens in plain text files. All sensitive fields must use <InlineCode>"encrypted": true</InlineCode> in <InlineCode>globalConfig.json</InlineCode>. The actual value is entered by the user inside Splunk's configuration UI and stored securely by Splunk's credential manager.
        </Note>

        <Heading level={4}>How to get the best results</Heading>
        <TwoCol>
          <DoBox $positive>
            <DoTitle $positive>✓ Good prompts</DoTitle>
            <DoList>
              <li>Be specific: "Add a modular input that polls the Acme REST API every 5 minutes and indexes JSON responses"</li>
              <li>Reference field names: "The API key field should be encrypted"</li>
              <li>Ask for fixes: "The build is failing with error X, fix it"</li>
              <li>Use suggested actions — they contain full context of what to do next</li>
            </DoList>
          </DoBox>
          <DoBox>
            <DoTitle>✗ Avoid</DoTitle>
            <DoList>
              <li>Vague requests like "make it better" without context</li>
              <li>Asking it to test against a live Splunk instance</li>
              <li>Asking it to generate an API key or secret</li>
              <li>Asking it to access external documentation URLs</li>
            </DoList>
          </DoBox>
        </TwoCol>

        <Heading level={4}>Suggested action buttons</Heading>
        <p style={{ color: '#9b9ea3', fontSize: '0.88rem' }}>
          After completing a task the AI surfaces 1–3 clickable next-step buttons below the chat. Clicking one immediately sends the full prompt — you don't need to type anything. Security warnings always appear as the first action button when sensitive fields are detected.
        </p>

        <Placeholder label="Suggested action buttons below chat" hint="Screenshot showing the 3 pill buttons: 'Store API key as encrypted field', 'Build & download the app', 'Add transforms.conf'" />

        <Heading level={4}>Tool calls</Heading>
        <p style={{ color: '#9b9ea3', fontSize: '0.88rem' }}>
          When the AI uses a tool (reading a file, writing code, building the app) you'll see a collapsible tool call bubble in the chat. Click it to see exactly what the AI read or wrote. The AI runs multiple tools in a single turn — this is normal and means it's doing thorough work.
        </p>

        <Heading level={4}>Keyboard shortcut</Heading>
        <p style={{ color: '#9b9ea3', fontSize: '0.88rem' }}>
          Press <Kbd>Enter</Kbd> to send a message. Use <Kbd>Shift+Enter</Kbd> for a new line within a message.
        </p>

        <Note $variant="tip">
          <strong>Checkpoint before big changes:</strong> Ask the AI to "checkpoint the project" before making large edits. It will save a named snapshot you can restore if something goes wrong — just ask it to "restore the checkpoint".
        </Note>
      </Section>

      {/* ── 6. AppInspect ───────────────────────────────────────────────── */}
      <Section id="appinspect">
        <SectionHeader>
          <SectionEmoji>🔍</SectionEmoji>
          <SectionTitle>AppInspect</SectionTitle>
        </SectionHeader>
        <SectionIntro>
          AppInspect runs Splunk's official certification checks against your built app. It appears in the Build panel after a successful build and tells you exactly what will pass or fail before you submit to SplunkBase or deploy to Splunk Cloud.
        </SectionIntro>

        <Placeholder label="AppInspect panel — results with Fix it buttons" hint="Screenshot showing failure cards with red left borders and Fix it buttons" />

        <Heading level={4}>Deployment targets</Heading>
        <CardGrid>
          <FCard icon="🌐" title="SplunkBase (Public)" body="Runs the full splunk_appinspect tag set — required for public SplunkBase submissions." />
          <FCard icon="☁️" title="Splunk Cloud (Victoria)" body="Runs private_victoria checks — for modern Splunk Cloud deployments." />
          <FCard icon="☁️" title="Splunk Cloud (Classic)" body="Runs private_classic checks — for legacy Splunk Cloud deployments." />
          <FCard icon="🏢" title="Self-hosted Enterprise" body="Runs splunk_appinspect excluding cloud-specific rules — for on-premise Splunk installations." />
        </CardGrid>

        <Heading level={4}>Output formats</Heading>
        <ul style={{ color: '#9b9ea3', fontSize: '0.88rem', lineHeight: 1.8 }}>
          <li><strong>JSON (interactive)</strong> — Results displayed inline with severity badges, file/line references, and Fix it buttons.</li>
          <li><strong>JUnit XML (download)</strong> — Machine-readable output for CI/CD pipelines (Jenkins, GitHub Actions, etc.).</li>
        </ul>

        <Heading level={4}>"Fix it" button</Heading>
        <p style={{ color: '#9b9ea3', fontSize: '0.88rem' }}>
          Every failure and warning card has a <strong>Fix it</strong> button. Clicking it opens the AI chat, pre-populated with the full context of that specific check failure — the check name, description, affected file, and line number. The AI immediately works on resolving it.
        </p>

        <Note $variant="info">
          <strong>Requires splunk-appinspect CLI:</strong> Install with <InlineCode>pip install splunk-appinspect</InlineCode>. The panel shows an installation prompt if the CLI is not found. The backend server must also be running.
        </Note>
      </Section>

      {/* ── 7. GitHub ───────────────────────────────────────────────────── */}
      <Section id="github">
        <SectionHeader>
          <SectionEmoji>🐙</SectionEmoji>
          <SectionTitle>GitHub Integration</SectionTitle>
        </SectionHeader>
        <SectionIntro>
          Connect to GitHub to push your app source directly to a repository or clone an existing app repo into the editor. Uses GitHub's device-flow OAuth — no password or personal access token required.
        </SectionIntro>

        <Placeholder label="GitHub panel — connected state showing repo list" hint="Screenshot showing the GitHub panel with 'Push to repo' and repo dropdown" />

        <StepList>
          <StepItem>
            <StepContent>
              <StepTitle>Connect</StepTitle>
              Click <strong>GitHub</strong> in the nav bar. A device code is shown — visit <InlineCode>github.com/login/device</InlineCode> and enter it to authorise. You stay connected until you clear browser storage.
            </StepContent>
          </StepItem>
          <StepItem>
            <StepContent>
              <StepTitle>Push to GitHub</StepTitle>
              Select an existing repo (or create a new one), choose a branch, and push. Only source files are pushed — not generated output, keeping your repo clean.
            </StepContent>
          </StepItem>
          <StepItem>
            <StepContent>
              <StepTitle>Import from GitHub</StepTitle>
              From the Home screen, click <strong>Import from GitHub</strong>. Choose a repo and branch to load its files into the editor. Works with any UCC app repository.
            </StepContent>
          </StepItem>
        </StepList>
      </Section>

      {/* ── 8. Import / Export ──────────────────────────────────────────── */}
      <Section id="import">
        <SectionHeader>
          <SectionEmoji>📦</SectionEmoji>
          <SectionTitle>Import &amp; Export</SectionTitle>
        </SectionHeader>
        <SectionIntro>
          Bring existing Splunk apps into the builder to edit them, or export your source for version control and CI/CD.
        </SectionIntro>

        <Heading level={4}>Importing an app</Heading>
        <p style={{ color: '#9b9ea3', fontSize: '0.88rem' }}>
          Click <strong>Import</strong> in the nav bar and drop or browse for a file. Three formats are supported:
        </p>
        <CardGrid>
          <FCard icon="📁" title=".zip (source)" body="A source ZIP exported from this tool or from a UCC project. Full fidelity — all source files are imported as-is." />
          <FCard icon="📦" title=".tgz / .spl (compiled)" body="A compiled Splunk app package. The importer decompresses the tarball, classifies each file, and loads everything into the editor." />
          <FCard icon="📄" title="Paste globalConfig.json" body="From the Home screen, choose 'Start from globalConfig.json' and paste an existing config to scaffold the full project around it." />
        </CardGrid>
        <p style={{ color: '#9b9ea3', fontSize: '0.88rem' }}>
          After importing, each file is classified as <strong>source</strong> (hand-written), <strong>generated</strong> (auto-created by ucc-gen), or <strong>unknown</strong>. Source files are shown by default; generated files are visible in Dev Mode.
        </p>

        <Placeholder label="Import screen — file drop zone and post-import file list" hint="Screenshot showing the import panel after a .tgz is uploaded, with file origin badges" />

        <Heading level={4}>Exporting</Heading>
        <ul style={{ color: '#9b9ea3', fontSize: '0.88rem', lineHeight: 1.8 }}>
          <li><strong>Download App</strong> (nav bar) — Full compiled <InlineCode>.zip</InlineCode> ready for Splunk installation.</li>
          <li><strong>Export Source</strong> (nav bar) — Source-only <InlineCode>.zip</InlineCode> for version control. Excludes generated files to keep your repo small.</li>
          <li><strong>Push to GitHub</strong> — Same as Export Source but commits directly to a repository.</li>
        </ul>
      </Section>

      {/* ── 9. Dev Mode ─────────────────────────────────────────────────── */}
      <Section id="devmode">
        <SectionHeader>
          <SectionEmoji>⚙️</SectionEmoji>
          <SectionTitle>Dev Mode</SectionTitle>
        </SectionHeader>
        <SectionIntro>
          Dev Mode is a toggle in the nav bar that controls which files are visible in the file tree.
        </SectionIntro>

        <TwoCol>
          <DoBox $positive>
            <DoTitle $positive>Dev Mode OFF (default)</DoTitle>
            <DoList>
              <li>Shows only source files you wrote or edited</li>
              <li>Clean view — only the files that matter for development</li>
              <li>Ideal for day-to-day editing</li>
            </DoList>
          </DoBox>
          <DoBox>
            <DoTitle>Dev Mode ON</DoTitle>
            <DoList>
              <li>Shows ALL files including auto-generated ones</li>
              <li>Reveals <InlineCode>app.manifest</InlineCode>, <InlineCode>__init__.py</InlineCode> stubs, generated conf files, icon files</li>
              <li>Useful for debugging or inspecting the full output</li>
            </DoList>
          </DoBox>
        </TwoCol>

        <Note $variant="warning">
          <strong>Be careful editing generated files in Dev Mode.</strong> Changes to generated files may be overwritten the next time the wizard regenerates the project. Prefer editing source files unless you know what you are doing.
        </Note>
      </Section>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <div style={{ borderTop: `1px solid ${variables.borderColor}`, paddingTop: 32, marginTop: 32, color: '#9b9ea3', fontSize: '0.82rem', textAlign: 'center' }}>
        Built with the <strong>UCC framework</strong> · Splunk App Builder · Feedback via GitHub Issues
      </div>
    </Page>
  );
}
