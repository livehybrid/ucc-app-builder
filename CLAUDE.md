# Software Requirements Specification (SRS) - Splunk App Builder

## 1. Introduction

### 1.1 Purpose
This document specifies the requirements for the **Splunk App Builder**, a web-based tool that helps users build Splunk apps/add-ons using the Universal Configuration Console (UCC) framework and `ucc-gen`, with both wizard-driven and code-centric experiences, plus AI-assisted workflows.

It is intended for:
- Human development teams (frontend, backend, DevOps).
- AI development agents (e.g., Claude Code SDK–based automation).

### 1.2 Scope
The system is a browser-based application that enables users to:

- Define a UCC-based Splunk app via a **Basic Wizard** or an **Advanced JSON editor**.
- Execute **`ucc-gen`** to generate boilerplate app structure based on `globalConfig.json`.
- Browse and edit the generated app in a **secure, virtual file browser + Monaco editor**.
- Use **AI assistance** (OpenRouter + Claude Code SDK) to generate, review, and refine configuration and code.
- Package the resulting app into a **ZIP file** for deployment to Splunk Enterprise/Splunk Cloud.

No Splunk Cloud SDK integration is required; generated apps must be compatible with both Splunk Enterprise and Splunk Cloud as standard UCC-based add-ons.

### 1.3 Definitions, Acronyms, Abbreviations
- **UCC**: Universal Configuration Console, Splunk framework for add-on generation.
- **`ucc-gen`**: CLI code generation tool that produces Splunk add-on boilerplate from configuration (including `globalConfig.json`).
- **globalConfig.json**: UCC configuration file defining pages, inputs, alert actions, authentication, etc.
- **Monaco Editor**: Browser-based code editor used in VS Code.
- **Claude Code SDK**: Anthropic SDK for deep code context + automation, used as AI pair programmer.
- **OpenRouter**: API router providing access to multiple LLMs, used here to call Claude models.
- **JSZip**: JavaScript library for ZIP file creation in the browser.

## 2. Overall Description

### 2.1 Product Perspective
The Splunk App Builder is a **standalone web app** (static assets) that may call:
- A local/remote backend service (optional) to execute `ucc-gen` safely.
- External AI API (OpenRouter) for chat and code assistance.

It complements the official UCC-based workflows for creating Splunk add-ons.

### 2.2 User Classes and Characteristics

| User Type | Description | Mode Used |
|-----------|-------------|-----------|
| **Novice Developer / Consultant** | Limited knowledge of Splunk internals and UCC. Prefers guided forms, wizards, and templates. | **Basic Wizard** |
| **Advanced Developer / Add-on Engineer** | Comfortable with JSON, Python, Splunk conf files, UCC concepts. | **Advanced Editor** |
| **DevOps / Automation Engineer** | Wants repeatable app scaffolding, minimal manual steps. | Both |
| **Designer / Product Owner** | Interested in branding: logo, nav bar color, app metadata. | Wizard |

### 2.3 Operating Environment
- Modern desktop browsers: Chrome 90+, Edge 90+, Firefox 88+, Safari 14+.
- Local static hosting (Python `http.server`, Node `http-server`) or static hosting platforms (Netlify, Vercel, GitHub Pages).
- Optional backend (Node/Python) for `ucc-gen` execution.

## 3. Functional Requirements

### 3.1 Dual Onboarding Modes

#### 3.1.1 Basic Wizard (**FR-1**)
**Multi-step wizard for novices with these steps:**

1. **App Details**
   - Fields: app name, description, author, version, internal ID.
2. **Logo Configuration**
   - Options:
     - Upload logo file (PNG/JPEG/SVG), validate size and type.
     - Generate logo via AI (text-to-image API) using app name and description as prompt context.
3. **Navigation Bar Style**
   - Color picker (HEX input) plus preset schemes (e.g., Splunk-like orange, blue, green).
   - Live preview representing Splunk nav bar.
4. **Component Selection**
   - Binary toggles for:
     - Modular Inputs
     - Custom Commands
     - Alert Actions
     - API Credentials / Auth configuration
5. **Review & Generate**
   - Show human-readable summary.
   - Show derived `globalConfig.json` preview based on prior answers.

**FR-2**: Wizard shall validate required fields and prevent progression when invalid.

**Acceptance Criteria**:
- Novice user can complete wizard without knowing JSON.
- Valid `globalConfig.json` is generated or clearly highlighted for missing advanced sections.

#### 3.1.2 Advanced Editor (**FR-3**)
**Advanced Mode where users:**
- Directly edit `globalConfig.json` in Monaco Editor (JSON mode).
- See file tree of current app structure (when generated).
- Can trigger "Generate/Build App" from this screen.

**FR-4**: Editor shall show JSON validation errors inline.

**Acceptance Criteria**:
- Advanced users can bypass wizard and work with raw configuration.
- Invalid JSON visually marked and blocks `ucc-gen` execution until resolved.

### 3.2 UCC & `ucc-gen` Integration

**FR-5**: System shall use `globalConfig.json` plus minimal metadata to drive `ucc-gen` runs.

**FR-6**: Backend/sandbox execution service that:
- Receives `globalConfig.json` (and other required UCC project files).
- Executes `ucc-gen` commands:
  - `ucc-gen init` (optional, if bootstrapping from scratch).
  - `ucc-gen build` to generate app code from `package/` directory.
  - `ucc-gen package` to produce deployable artifact if needed.
- Returns resulting folder structure to frontend in safe format.

**FR-7**: Robust error reporting for `ucc-gen`:
- Show CLI output, errors, exit codes.
- Provide AI-generated suggestions for fixes.

**Acceptance Criteria**:
- Given valid `globalConfig.json`, full UCC-based Splunk add-on generated containing expected directories/files.

### 3.3 File Browser & Secure Editing

**FR-8**: Virtual file browser displays generated app structure:
- Expandable folders, file type icons (Python, JSON, conf, XML, etc.).

**FR-9**: Selected files open in Monaco editor with correct language mode based on extension.

**FR-10**: Editing operations constrained to VFS representation of `ucc-gen` output.

**FR-11**: Maintain in-memory modifications, allow re-running `ucc-gen` while preserving user-edited files when appropriate.

**Acceptance Criteria**:
- Users can navigate/edit generated files safely without filesystem access beyond app tree.
- Malicious path traversal (`../../`) not possible.

### 3.4 Packaging & ZIP Download

**FR-12**: Frontend uses JSZip to:
- Take in-memory VFS representation of app.
- Generate ZIP archive with standard Splunk app structure.
- Trigger browser file download.

**FR-13**: ZIP must be installable on Splunk instance (`$SPLUNK_HOME/etc/apps/...`).

**Acceptance Criteria**:
- ZIP can be installed into Splunk Enterprise/Cloud and appears as valid app/add-on with UCC UI.

### 3.5 AI Integration (OpenRouter + Claude Code SDK)

#### 3.5.1 Chat Window (**FR-14**)
Persistent **Chat drawer** that:
- Shows conversation history.
- Accepts natural language questions.
- Can be opened from any main screen.

**FR-15**: Messages sent to OpenRouter using API key entered in Settings (stored in browser memory only).

#### 3.5.2 Context-Aware Assistance (**FR-16**)
AI backend receives:
- Current file contents, `globalConfig.json`, error logs.
- Suggests code completions/fixes inline.
- Explains UCC concepts (pages, inputs, auth, alert actions).

**FR-17**: Claude Code SDK orchestrates multi-step coding tasks (modular input handlers, etc.).

**FR-18**: "Ask AI" entry points in editor (right-click/button) send selected text/errors to AI.

**Acceptance Criteria**:
- Users can ask: "Generate modular input for REST API X" → receive code skeleton.
- Users can ask for UCC error explanation → get actionable guidance.

### 3.6 Logo Generation & Branding

**FR-19**: Wizard allows:
- Logo upload with client-side validation/preview.
- AI-generated logo via text-to-image API.

**FR-20**: Use app name + description + style preset to form prompts. Store in `static/` folder.

**FR-21**: Navigation bar color generates Splunk navigation XML/configuration.

**Acceptance Criteria**:
- Installed app has recognizable logo/themed nav color matching user selections.

### 3.7 Workflow Guidance

**FR-22**: Post-`ucc-gen`, propose contextual **next steps**:
- "Configure your first modular input."
- "Define alert actions."
- "Review generated REST handlers."

**FR-23**: Steps open guided panels or trigger AI-assisted prompts.

**Acceptance Criteria**:
- Novice users follow steps from blank state to minimal working add-on.
- Advanced users can ignore/collapse guidance.

## 4. Non-Functional Requirements

### 4.1 Performance
- **NFR-1**: Initial app load < 4 seconds.
- **NFR-2**: `ucc-gen` execution latency backend-dependent; UI shows progress.

### 4.2 Security
- **NFR-3**: No filesystem writes outside scoped app directory.
- **NFR-4**: OpenRouter API key never stored server-side.
- **NFR-5**: All communication uses HTTPS.

### 4.3 Compatibility
- **NFR-6**: Generated apps follow UCC conventions (`splunk-add-on-ucc-framework`).
- **NFR-7**: Deployable on Splunk Enterprise and Cloud.

### 4.4 Usability
- **NFR-8**: Keyboard navigation, ARIA roles.
- **NFR-9**: Distinct "Novice"/"Advanced" modes.

## 5. External Interface Requirements

### 5.1 User Interfaces
- Header: App name, Settings, AI Assistant toggle.
- Main panels: Welcome, Basic Wizard, Advanced Editor, File Browser.
- Side panels: Chat drawer, Settings.

### 5.2 Software Interfaces
- `ucc-gen` CLI via backend (Node/Python subprocess).
- OpenRouter HTTP API for AI prompts.
- Optional: Splunk React UI components.

## 6. Constraints and Assumptions
- User provides OpenRouter API key.
- `ucc-gen` and UCC framework available to backend.
- No Splunk Cloud SDK integration.

## 7. Acceptance Criteria Summary
1. Novice builds/downloads minimal UCC-based app using only wizard.
2. Advanced developer bypasses wizard, edits `globalConfig.json`, runs `ucc-gen`, refines code.
3. AI provides help for configuration, code generation, error explanation.
4. ZIP produced installs into Splunk as valid app/add-on.

***

**Copy this entire document** - it's ready for developer handoff, backlog creation, or AI agent ingestion.
