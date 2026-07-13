/**
 * UCC framework knowledge: entity field types, validators, built-in tabs,
 * input service structure, and naming rules.
 * Update this file when the UCC schema changes or new field types are added.
 */

export const UCC_KNOWLEDGE_SECTION = `## UCC Framework Knowledge

### Entity Field Types
- \`text\`: Single-line input (names, custom URLs, arbitrary strings)
- \`textarea\`: Multi-line input (descriptions, queries)
- \`singleSelect\`: Dropdown select one (account selection)
- \`multipleSelect\`: Dropdown select many
- \`checkbox\`: Boolean toggle (enable/disable)
- \`radioBar\`: Radio button group (mode selection)
- \`file\`: File upload (certificates)
- \`oauth\`: OAuth configuration
- \`interval\`: Time interval picker (polling frequency)
- \`index\`: Splunk index selector — **always use this for index destination fields, never \`text\`**. Renders a Splunk index picker dropdown in Manager.
- \`password\`: Masked text input — use with \`"encrypted": true\` for credentials

### Validators
- \`string\`: { minLength, maxLength }
- \`regex\`: { pattern }
- \`number\`: { range: [min, max], isInteger }
- \`url\`, \`email\`, \`ipv4\`, \`date\`: No params needed

### Built-in Configuration Tabs
- \`"type": "loggingTab"\`: Standard logging configuration
- \`"type": "proxyTab"\`: Proxy settings

### Input Service Structure
\`\`\`json
{
  "name": "my_input",
  "title": "My Input",
  "entity": [
    { "type": "text", "field": "name", "label": "Name", "required": true },
    { "type": "interval", "field": "interval", "label": "Interval", "defaultValue": "300" },
    { "type": "index", "field": "index", "label": "Index", "required": true }
  ]
}
\`\`\`

### Naming Rules (CRITICAL)
- Service \`name\`, tab \`name\`, and alert \`name\` fields MUST match \`/^[a-zA-Z0-9_]+$/\` — only letters, numbers, underscores.
- **No spaces, hyphens, dots, or special characters.** Use snake_case: \`energy_api_input\` not \`Energy API Input\`.
- The server validates this on every write and will reject invalid names with an actionable error.
- The \`title\` field (human-readable label) CAN contain spaces and special characters.`;
