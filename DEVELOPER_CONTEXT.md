# Splunk App Builder - Developer Context

## Project Vision
The Splunk App Builder is designed to provide a modern, high-fidelity IDE and wizard experience for building Splunk Add-ons using the **UCC (Universal Configuration Console)** framework.

Unlike the legacy Splunk Add-on Builder, this tool is:
- **CI/CD Friendly**: It manages files in a way that prioritizes source-only exports for version control.
- **Web-Native**: Runs in the browser with a virtual file system (VFS).
- **Extensible**: Supports rich validation and IntelliSense for Splunk `.conf` files.

## Architecture
- **Frontend**: Vite + React + TypeScript.
- **VFS**: A recursive tree structure (Map-based) representing files and directories in memory.
- **IDE**: Monaco Editor with custom language registration (`splunk-conf`) and JSON schema validation.
- **Backend**: Node.js Express server that orchestrates `ucc-gen` (Python CLI) for actual app compilation.

## Key Files & Modules
- `src/lib/vfs.ts`: The heart of file management.
- `src/lib/specParser.ts`: Ingests Splunk `.spec` files to provide real-time validation.
- `src/lib/generator.ts`: Logic for creating the initial UCC project structure.
- `server/services/uccGen.ts`: Handles communication with the Python environment.

## Current Status
- **Phase 1 & 2**: Complete. Basic wizard, VFS, Monaco integration, and backend build service are all operational.
- **Production Build**: Verified. `npm run build` is stable and error-free.
- **Testing**: Core libraries have high coverage.

## Outstanding Tasks (Roadmap)
1. **AI Integration**: Chat drawer and contextual code generation (OpenRouter).
2. **OAuth 2.0**: Specialized wizards for complex authentication flows.
3. **Validation Polish**: Further refining the SpecParser to handle all edge cases in Splunk's schema.
4. **DevOps**: Dockerization and NPM package packaging.
