# Goal: Build and Verify App

> **Objective**: Generate the Splunk App artifact using `ucc-gen` and verify its integrity.

## Inputs
- **Configuration**: Current state of `globalConfig.json` and `.conf` specs.
- **Source Code**: Current state of `package/` directory.

## Process

1.  **Pre-Build Validation**
    - Ensure `globalConfig.json` is valid JSON.
    - Verify all required fields in `package.json` are present.
    - Check that `ucc-gen` is installed and accessible in the environment.

2.  **Execute Build**
    - Run the build command: `npm run build:app` (or equivalent script).
    - Monitor output for `ucc-gen` errors or warnings.
    - If errors occur, analyze log output and trace back to configuration source.

3.  **Post-Build Verification**
    - Inspect `output/` directory (or build target).
    - Verify key files exist: `app.conf`, `inputs.conf`, `server.conf`.
    - Specific checks:
        - `default/app.conf`: Version matches.
        - `bin/`: Python scripts are present and executable.
        - `appserver/static/`: JS/CSS assets are generated.

4.  **Troubleshooting**
    - If build fails on `globalConfig.json` validation: Check schema compliance.
    - If build fails on Python dependencies: Check `lib/` requirements.

## Expected Output
- A successfully built Splunk App package in the output directory.
- Build log (if errors occurred).
