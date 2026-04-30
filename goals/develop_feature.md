# Goal: Develop Feature

> **Objective**: Implement a new feature or enhancement in the Splunk App Builder (frontend or backend).

## Inputs
- **Feature Description**: Clear requirements of what to build.
- **Relevant Files**: Paths to existing code or new file locations.
- **Context**: `context/tech_stack.md` and `context/project_overview.md`.

## Process

1.  **Plan Implementation**
    - Review requirements against `context/project_overview.md`.
    - Identify impacted components (Frontend: `src/`, Backend: `server/`).
    - Check for existing patterns in `src/components/` or `src/lib/`.
    - Draft a mini-plan in `task.md`.

2.  **Frontend Development (React/Vite)**
    - Create/modify components in `src/components/`.
    - Use TailwindCSS for styling (adhere to existing design system).
    - Ensure accessibility and responsiveness.
    - Validate logic with `npm run dev` (if applicable).

3.  **Backend Development (Node/Express)**
    - Modify API endpoints in `server/`.
    - Ensure proper error handling and logging.
    - Update `server/services/uccGen.ts` if interacting with `ucc-gen`.

4.  **Integration & Logic**
    - Update `src/lib/vfs.ts` if file operations are involved.
    - Update `src/lib/specParser.ts` if validation logic changes.
    - Ensure state is correctly managed (Context/Redux/Zustand if used).

5.  **Verification**
    - Verify UI changes in browser (if running).
    - Run linting/formatting checks (`npm run lint`).
    - Verify backend endpoints (if applicable).

## Expected Output
- Implemented feature code.
- Updated tests (if applicable).
- Verified functionality.
