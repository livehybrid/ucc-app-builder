# Splunk App Builder - Feature Roadmap & Task Tracking

## Overview

This document tracks the implementation progress of the Splunk App Builder, comparing current features against the full UCC framework capabilities.

---

## Current Implementation Status

### ✅ Phase 1: Foundation (COMPLETE)

| Feature | Status | Notes |
|---------|--------|-------|
| Project setup (Vite + React + TypeScript) | ✅ Done | |
| Virtual File System (VFS) | ✅ Done | 94% test coverage |
| Basic Wizard (4 steps) | ✅ Done | Details, Branding, Components, Review |
| globalConfig.json generation | ✅ Done | 100% test coverage |
| ZIP packaging (JSZip) | ✅ Done | 100% test coverage |
| File Browser | ✅ Done | Tree view with syntax highlighting |
| CI/CD Pipeline (GitHub Actions) | ✅ Done | typecheck → lint → test → build |
| App Import with Source Tracking | ✅ Done | 95% test coverage |
| Source Export for Version Control | ✅ Done | 96% test coverage |
| .uccproject file format | ✅ Done | Portable project definition |
| Build manifest tracking | ✅ Done | File origin classification |

### Test Coverage Summary

```
Test Files  7 passed (7)
Tests       76 passed (76)

Library Coverage:
- crypto.ts        100%
- packager.ts      100%
- globalConfig.ts  100%
- manifest.ts      100%
- generator.ts     96%
- exporter.ts      96%
- importer.ts      95%
- vfs.ts           94%
```

---

## 🚧 Phase 2: User Feedback Implementation (COMPLETE)

Based on user testing feedback, the following improvements are needed:

### 2.1 Icon Upload & Resizing (Branding Tab)
- [x] Add icon upload to Branding step (Step 2)
- [x] Implement client-side image resizing using Canvas API
- [x] Generate all required Splunk icon sizes:
  - `appIcon.png` (36x36)
  - `appIcon_2x.png` (72x72)
  - `appIconAlt.png` (36x36)
  - `appIconAlt_2x.png` (72x72)
  - `appLogo.png` (160x40 or similar)
- [x] Store resized icons in VFS `/static/` directory
- [x] Preview uploaded icon in wizard

### 2.2 Dynamic Component Builder (Components Tab)
Current: Simple on/off checkboxes
Needed: Add/remove multiple instances with full configuration

#### 2.2.1 Modular Inputs
- [x] Change from checkbox to "Add Input" button
- [x] Input configuration form:
  - Name (internal ID)
  - Title (display name)
  - Description
  - Entity fields (dynamic list):
    - Field name
    - Field type (text, password, checkbox, dropdown, etc.)
    - Required/optional
    - Default value
    - Help text
    - Validators
  - Interval configuration
  - Index selection
- [x] Support multiple inputs (list with add/remove)
- [x] Generate Python input handler template

#### 2.2.2 Custom Commands
- [x] Add custom command configuration
- [x] Fields from commands.conf:
  - Command name
  - Type (streaming, reporting, generating, etc.)
  - Filename (Python script)
  - chunked (true/false)
  - maxinputs
  - passauth
  - enableheader
  - requires_srinfo
  - supports_getinfo
  - supports_rawargs
  - supports_multivalues
- [x] Generate Python command template

#### 2.2.3 Alert Actions
- [x] Full alert action configuration
- [x] Fields:
  - Name
  - Label
  - Description
  - Icon path
  - Entity fields (same as inputs)
  - Payload format
- [x] Generate alert action Python template

#### 2.2.4 API Credentials / Authentication
- [x] Multiple credential configurations
- [x] Fields:
  - Account name
  - Auth type (Basic, OAuth 2.0, API Key)
  - For Basic: username, password fields
  - For OAuth: client_id, client_secret, redirect_uri, token_url, auth_url, scopes
  - For API Key: key field, header name
  - Custom fields (dynamic add):
    - URI
    - Account number
    - Region
    - Any custom field

#### 2.2.5 Custom REST Endpoints
- [x] Add REST endpoint configuration
- [x] Fields:
  - Endpoint name
  - REST handler class
  - Methods (GET, POST, PUT, DELETE)
  - Authentication required
- [x] Generate REST handler Python template

### 2.3 Rich File Editor (Monaco Integration)
Current: View-only file display
Needed: Full editing capabilities

- [x] Replace code preview with Monaco Editor
- [x] Enable file editing and save to VFS
- [x] Right-click context menu on file tree:
  - New File
  - New Folder
  - Rename
  - Delete
  - Duplicate
- [x] JSON validation for globalConfig.json (using official schema)
- [x] Schema validation for Splunk .conf files:
  - inputs.conf
  - commands.conf
  - app.conf
  - restmap.conf
  - web.conf
- [x] Syntax highlighting for:
  - Python (.py)
  - JSON (.json)
  - INI/conf (.conf)
  - XML (.xml)
- [x] Auto-save or explicit save button
- [x] Unsaved changes indicator
- [x] Image previews for icons

### 2.4 Metadata Generation
- [ ] Generate `default/meta.conf` with proper permissions
- [ ] Generate `metadata/default.meta`
- [ ] Generate `metadata/local.meta`
- [ ] Follow UCC metadata conventions

### 2.5 UCC Build Integration (Backend)
Current: Downloads pre-build source files only
Needed: Actual ucc-gen compilation

- [x] Create backend service (Node.js or Python)
- [x] Endpoints:
  - `POST /api/build` - Run ucc-gen build
  - `POST /api/package` - Create deployable package
  - `GET /api/build-status` - Check build progress
- [x] ucc-gen integration:
  - Receive source files from frontend
  - Write to temp directory
  - Execute `ucc-gen build`
  - Return compiled output or errors
- [x] Error handling and display
- [x] Build log streaming
- [x] Two download options:
  - "Download Source" - Current behavior (for git)
  - "Download Built App" - Compiled via ucc-gen (for Splunk)

---

## UCC Framework Feature Matrix

Based on [UCC Framework Documentation](https://splunk.github.io/addonfactory-ucc-generator/).

### Entity/Field Types

| Entity Type | Wizard Support | Advanced Editor | Priority |
|-------------|---------------|-----------------|----------|
| `text` | ⬜ Needs update | ⬜ Not started | P0 |
| `password` | ⬜ Needs update | ⬜ Not started | P0 |
| `checkbox` | ⬜ Not started | ⬜ Not started | P1 |
| `singleSelect` (dropdown) | ⬜ Not started | ⬜ Not started | P1 |
| `multipleSelect` | ⬜ Not started | ⬜ Not started | P2 |
| `radio` | ⬜ Not started | ⬜ Not started | P2 |
| `textarea` | ⬜ Not started | ⬜ Not started | P1 |
| `file` | ⬜ Not started | ⬜ Not started | P2 |
| `oauth` | ⬜ Not started | ⬜ Not started | P1 |
| `helpLink` | ⬜ Not started | ⬜ Not started | P3 |
| `custom` (React components) | ⬜ Not started | ⬜ Not started | P3 |

### Validators

| Validator | Implemented | Priority |
|-----------|-------------|----------|
| `string` (minLength, maxLength) | ⬜ Not started | P1 |
| `number` (min, max, isInteger) | ⬜ Not started | P1 |
| `regex` (pattern matching) | ⬜ Not started | P1 |
| `url` | ⬜ Not started | P2 |
| `email` | ⬜ Not started | P2 |
| `ipv4` | ⬜ Not started | P2 |
| `date` | ⬜ Not started | P3 |

### Configuration Pages

| Feature | Implemented | Priority |
|---------|-------------|----------|
| Account/Credentials tab | ⬜ Needs update | P0 |
| Logging configuration | ⬜ Not started | P1 |
| Proxy configuration | ⬜ Not started | P1 |
| Custom configuration tabs | ⬜ Not started | P2 |
| Tab groups | ⬜ Not started | P2 |

### Inputs

| Feature | Implemented | Priority |
|---------|-------------|----------|
| Basic modular input structure | ⬜ Needs update | P0 |
| Input services definition | ⬜ Not started | P0 |
| Multi-level menu | ⬜ Not started | P2 |
| Input tabs | ⬜ Not started | P2 |
| Interval configuration | ⬜ Not started | P1 |
| Index selection | ⬜ Not started | P1 |
| Input helper modules | ⬜ Not started | P2 |

### Alert Actions

| Feature | Implemented | Priority |
|---------|-------------|----------|
| Basic alert action structure | ⬜ Needs update | P0 |
| Alert action entities | ⬜ Not started | P1 |
| Adaptive response | ⬜ Not started | P2 |
| Alert action scripts | ⬜ Not started | P1 |

### Authentication

| Feature | Implemented | Priority |
|---------|-------------|----------|
| Basic auth (username/password) | ⬜ Needs update | P0 |
| OAuth 2.0 authorization code | ⬜ Not started | P1 |
| OAuth 2.0 client credentials | ⬜ Not started | P1 |
| OAuth token refresh | ⬜ Not started | P1 |
| API key authentication | ⬜ Not started | P1 |
| Custom auth endpoints | ⬜ Not started | P2 |

### Advanced Features

| Feature | Implemented | Priority |
|---------|-------------|----------|
| Dependent dropdowns | ⬜ Not started | P2 |
| Modify fields on change | ⬜ Not started | P2 |
| Custom mapping | ⬜ Not started | P3 |
| Groups feature | ⬜ Not started | P2 |
| Save validator | ⬜ Not started | P2 |
| Custom warning messages | ⬜ Not started | P3 |
| Sub-descriptions | ⬜ Not started | P3 |
| Help property | ⬜ Not started | P2 |

### REST & Backend

| Feature | Implemented | Priority |
|---------|-------------|----------|
| Custom REST handlers | ⬜ Not started | P1 |
| REST handler templates | ⬜ Not started | P2 |
| Backend ucc-gen execution | ⬜ Not started | P0 |
| OpenAPI spec generation | ⬜ Not started | P3 |

---

## Phase 3: Authentication & OAuth

### 3.1 OAuth 2.0 Support
- [ ] OAuth configuration wizard
- [ ] Authorization code flow
- [ ] Client credentials flow
- [ ] Token endpoint configuration
- [ ] Refresh token handling

### 3.2 API Key Authentication
- [ ] API key field type
- [ ] Header vs query parameter options
- [ ] Secure storage configuration

---

## Phase 4: Advanced Features

### 4.1 Dependent Fields
- [ ] Dependent dropdown configuration
- [ ] Modify fields on change
- [ ] Conditional field visibility

### 4.2 Custom REST Handlers
- [ ] REST handler configuration
- [ ] Handler template generation
- [ ] Endpoint documentation

---

## Phase 5: AI Integration

### 5.1 Chat Assistant
- [ ] OpenRouter integration
- [ ] Chat UI drawer
- [ ] Context-aware assistance
- [ ] API key management (browser-only)

### 5.2 AI-Powered Features
- [ ] Generate input handlers from description
- [ ] Error explanation
- [ ] Code review suggestions
- [ ] UCC concept explanations

---

## Phase 6: Polish & DevOps

### 6.1 Testing
- [ ] React component tests (RTL)
- [ ] E2E tests (Playwright)
- [ ] Integration tests for ucc-gen

### 6.2 Documentation
- [ ] User guide
- [ ] API documentation
- [ ] Video tutorials

### 6.3 Deployment
- [ ] Docker container for backend
- [ ] Hosted demo instance
- [ ] npm package for CLI usage

---

## Splunk Icon Requirements

Per Splunk documentation, apps need these icon files in `/static/`:

| File | Size | Purpose |
|------|------|---------|
| `appIcon.png` | 36x36 px | App icon (standard) |
| `appIcon_2x.png` | 72x72 px | App icon (retina) |
| `appIconAlt.png` | 36x36 px | Alternative icon |
| `appIconAlt_2x.png` | 72x72 px | Alternative icon (retina) |
| `appLogo.png` | Variable (160x40 suggested) | App logo for branding |

---

## commands.conf Options

Reference for custom command configuration:

| Option | Type | Description |
|--------|------|-------------|
| `filename` | string | Python script filename |
| `type` | enum | streaming, reporting, generating, eventing |
| `chunked` | bool | Use chunked protocol |
| `maxinputs` | int | Max input events |
| `passauth` | bool | Pass auth token |
| `enableheader` | bool | Include header row |
| `requires_srinfo` | bool | Requires search info |
| `supports_getinfo` | bool | Supports getinfo command |
| `supports_rawargs` | bool | Supports raw arguments |
| `supports_multivalues` | bool | Supports multi-value fields |

---

## Priority Legend

| Priority | Description |
|----------|-------------|
| **P0** | Must have - Core functionality, blocking user workflow |
| **P1** | Should have - Common use cases |
| **P2** | Nice to have - Advanced features |
| **P3** | Future - Edge cases & extensibility |

---

## Sources

- [UCC Framework Documentation](https://splunk.github.io/addonfactory-ucc-generator/)
- [UCC GitHub Repository](https://github.com/splunk/addonfactory-ucc-generator)
- [Splunk Add-on Builder Documentation](https://docs.splunk.com/Documentation/AddonBuilder)
- [commands.conf spec](https://docs.splunk.com/Documentation/Splunk/latest/Admin/Commandsconf)

---

## Agent Rebuild (Nov 2026)

Research + implementation to turn the AI chat panel into a **Lovable-for-Splunk**
class agent. Full rationale in [`docs/research/00-synthesis.md`](docs/research/00-synthesis.md).

### Agent Phase 1 (SHIPPED — branch `feat/agent-rebuild`)

- [x] Research: SOTA agent architectures, models, tool patterns, RAG, UX, security
- [x] Research: OSS coding-agent repos + Kimi K2.6 + local-RAG alternatives
- [x] New edit tools: `apply_patch` (Aider-style fuzzy diff), `create_file`
- [x] Planning / memory tools: `todo_write`, `record_decision`, `read_memory`, `write_memory`
- [x] Domain tools (self-hostable, no embeddings): `get_stanza_spec`, `list_stanzas` backed by a bundled `.conf.spec` parser
- [x] Verify-loop tools: `run_ucc_gen`, `run_appinspect`, `install_to_splunk_docker`, `browser_check`
- [x] Model profile env: `MODEL_PROFILE` = `kimi-single` (default) / `anthropic-multi` / `openai-multi` / `local-ollama`
- [x] Local JSONL trace sink (`.ucc-agent/traces/*.jsonl`); Langfuse optional
- [x] Playwright E2E harness + smoke test (`npm run test:e2e`)
- [x] UCC-bench v0 with runner + one task (`npm run bench`)
- [x] Server-side Splunk Docker installer + AppInspect wrapper

### Agent Phase 2 (NEXT)

- [ ] Server-side Planner / Executor loop with streaming SSE
- [ ] `AIChatPanel` refactor — plan view, todo tracker, decision log UI
- [ ] Approval policy: auto-allow reads + spec lookups; human-in-loop for Docker / network / writes outside `package/`
- [ ] Add 4 more UCC-bench tasks (alert action, custom command, OAuth app, adaptive-response)
- [ ] FlexSearch index over bundled add-on examples for `consult_documentation`
- [ ] Kimi K2.6 integration tests against OpenRouter + Ollama

### Agent Phase 3

- [ ] Per-session sandbox (Firecracker/gVisor)
- [ ] Prompt-injection classifier on tool outputs
- [ ] Langfuse optional sink
- [ ] Live preview of running Splunk add-on

## Phase 7: Developer Experience Improvements

### 7.1 Validation & Quality
- [ ] **AppInspect CLI integration** — Run `splunk-appinspect inspect` after build; select deployment target (SplunkBase, Private Cloud Classic/Victoria, Self-hosted); output as JSON (interactive results panel) or JUnitXML (download); "Fix it" button per failure injects failure context into AI chat
- [ ] **Security scanner in build pipeline** — Pre-build scan of all .py/.conf files for hardcoded credentials, eval/exec on untrusted data, shell=True subprocess; surface as blocking warnings
- [ ] **Python unit test scaffolding** — AI generates test_<input>.py with mocked helper stubs so developers can test stream_events logic without a live Splunk instance

### 7.2 Import & Migration
- [ ] **Import existing app (.spl / tar.gz)** — Upload a built Splunk app and reverse-engineer it into VFS + globalConfig.json (GitHub and basic import UI exists but needs full testing)
- [ ] **Splunk Cloud migration assistant** — Flag everything that won't pass Splunk Cloud vetting: relative imports, subprocess, file system writes outside $SPLUNK_HOME, unsupported conf keys

### 7.3 Developer Tools
- [ ] **SPL query builder / tester** — Panel for writing SPL queries used in alert actions and custom commands; AI validates syntax, suggests optimisations, explains results
- [ ] **Event generator for testing** — Generate synthetic JSON/syslog/CEF events matching the input's sourcetype for use with Splunk's event generator or test assertions
- [ ] **KV Store schema designer** — Visual table editor for collections.conf + transforms.conf lookups with AI-generated conf stanzas and Python CRUD helper

### 7.4 Collaboration & Deployment
- [ ] **GitHub push / pull** — Export VFS to a GitHub repo branch or clone existing Splunk app repo into VFS (GitHub panel exists, needs full end-to-end testing)
- [ ] **Splunk ACS one-click deploy** — Integrate Splunk Admin Config Service API for direct Splunk Cloud deployment from a successful build
- [ ] **Shareable app snapshots** — Generate a time-limited permalink for current VFS state so developers can share work-in-progress without downloading

### 7.5 AI Quality
- [ ] **Full app review mode** — "Review App" button runs AI across every VFS file and produces prioritised findings: security, AppInspect risks, code quality, missing docs
- [ ] **Splunk version targeting** — User sets target version (8.x, 9.x, Cloud); AI constrains advice to available APIs/conf keys and flags deprecated patterns
- [ ] **Explain mode** — "Explain this file" produces plain-English description of what an input does, what data it collects, how it transforms events — for admins inheriting apps

---

## Changelog

| Date | Change |
|------|--------|
| 2024-02-05 | Initial roadmap created |
| 2024-02-05 | Phase 1 complete - Foundation & Import/Export |
| 2024-02-05 | 76 tests passing, 93%+ library coverage |
| 2024-02-05 | User feedback incorporated - Phase 2 tasks defined |
| 2026-11-22 | Agent rebuild Phase 1 shipped — new tools, Playwright, Docker install, Kimi default |
| 2026-05-06 | Phase 7 improvements roadmap added — AppInspect CLI integration, security scanner, SPL builder, and more |
