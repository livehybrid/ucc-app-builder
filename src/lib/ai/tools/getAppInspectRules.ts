import { Tool } from '../tools';

const APP_INSPECT_RULES = `# Splunk AppInspect — Key Rules for UCC Apps

## Critical (will block certification)

### SC-SVD-0002 — No hardcoded credentials
Passwords, API keys, tokens must never appear in conf files or Python as literals.
Use Splunk's encrypted credential storage (splunktaucclib CredentialManager / \`setup_util.get_credential\`).

### PY-001 — Valid Python syntax
All .py files must parse without SyntaxError. Run \`python3 -m py_compile <file>\` locally.

### PY-003 — No calls to os.system / subprocess with shell=True
Use subprocess.run(cmd, shell=False) with an explicit args list.

### W-010 — app.manifest present and valid JSON
\`package/app.manifest\` must exist and follow the 2.0.0 schema.

### W-002 — app.conf [ui] label must not be empty
\`label = My Add-on\` in [ui] stanza is required.

### W-003 — version in app.conf must match app.manifest
Both must carry identical semantic version strings.

## Warnings (will not block but should be fixed)

### PY-002 — Python 3 compatibility
No \`print\` statements, no \`basestring\`, no \`unicode()\`. Use \`six\` if you must support both.

### SC-SVD-0001 — No eval() / exec() on user-supplied data
Anything from conf files or HTTP request bodies counts as user-supplied.

### W-015 — README must be non-empty
\`package/README.txt\` (or README.md) must have meaningful content.

### CON-005 — inputs.conf must not have [default] stanza
UCC generates stanza names; a [default] stanza causes conflicts.

### CON-007 — commands.conf filename must match actual bin/ script
If \`filename = mycmd.py\` but \`package/bin/mycmd.py\` is missing, AppInspect fails.

## UCC-specific considerations

- \`globalConfig.json\` must conform to the UCC JSON schema (the builder validates this on write).
- Never ship \`package/default/data/ui/nav/default.xml\` — ucc-gen regenerates it; your version shadows it.
- \`package/lib/requirements.txt\` should list all third-party dependencies so ucc-gen can vendor them.
- Icons (\`appIcon.png\`, \`appIcon_2x.png\`, etc.) must be exactly 36×36 and 72×72 pixels respectively.
- The app id in \`globalConfig.json meta.name\`, \`app.conf [package] id\`, and \`app.manifest info.id.name\` must all match.
`;

export const getAppInspectRules: Tool = {
  name: 'get_app_inspect_rules',
  description:
    'Return a concise reference of Splunk AppInspect rules most relevant to UCC apps — ' +
    'covering credentials, Python quality, conf file correctness, and UCC-specific gotchas. ' +
    'Use this before finalising an app to check what might fail certification.',
  parameters: { type: 'object', properties: {} },
  execute: async () => APP_INSPECT_RULES,
};
