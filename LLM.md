# UCC Framework Knowledge Base for AI Assistant

> This document provides context for the AI assistant to help users build Splunk apps using the UCC framework.

## What is UCC?

Universal Configuration Console (UCC) is a Splunk framework that simplifies add-on creation by generating:
- UI (stored in `appserver/`)
- Python REST handlers (stored in `bin/`)
- Modular inputs and helper modules
- `.conf` files (stored in `default/`)
- Metadata files (stored in `metadata/`)
- OpenAPI docs (stored in `appserver/static/openapi.json`)

## Project Structure

```
package/
├── globalConfig.json     # Main configuration file
├── bin/                  # Python scripts (inputs, alert actions)
├── lib/                  # Python dependencies
├── default/              # .conf files (app.conf, inputs.conf, etc.)
├── metadata/             # default.meta
└── appserver/            # UI assets
```

## globalConfig.json Structure

```json
{
  "meta": {
    "name": "my_addon",
    "restRoot": "my_addon",
    "version": "1.0.0",
    "displayName": "My Add-on for Splunk",
    "schemaVersion": "0.0.3"
  },
  "pages": {
    "configuration": { "title": "Configuration", "tabs": [...] },
    "inputs": { "title": "Inputs", "services": [...] }
  },
  "alerts": [...]
}
```

## Entity Field Types

| Type | Description | Example Use |
|------|-------------|-------------|
| `text` | Single-line text input | Names, URLs, API keys |
| `textarea` | Multi-line text input | Descriptions, queries |
| `singleSelect` | Dropdown select one | Account selection |
| `multipleSelect` | Dropdown select many | Index selection |
| `checkbox` | Boolean toggle | Enable/disable features |
| `checkboxGroup` | Grouped checkboxes | Multi-option selection |
| `radioBar` | Radio button group | Mode selection |
| `file` | File upload | Certificates |
| `oauth` | OAuth configuration | API authentication |
| `interval` | Time interval picker | Polling frequency |
| `index` | Splunk index selector | Target index |
| `helpLink` | Display help link | Documentation links |

## Entity Field Properties

```json
{
  "type": "text",
  "field": "api_key",
  "label": "API Key",
  "help": "Enter your API key",
  "required": true,
  "encrypted": true,
  "defaultValue": "",
  "validators": [...]
}
```

## Validators

| Type | Properties | Description |
|------|------------|-------------|
| `string` | `minLength`, `maxLength` | Length validation |
| `regex` | `pattern` | Regex pattern match |
| `number` | `range: [min, max]`, `isInteger` | Numeric validation |
| `url` | (none) | URL format validation |
| `email` | (none) | Email format validation |
| `ipv4` | (none) | IPv4 address validation |
| `date` | (none) | Date format validation |

### Validator Example
```json
{
  "validators": [
    { "type": "string", "minLength": 1, "maxLength": 100, "errorMsg": "Must be 1-100 chars" },
    { "type": "regex", "pattern": "^[a-zA-Z]\\w*$", "errorMsg": "Must start with letter" }
  ]
}
```

## Configuration Tabs

### Custom Tab
```json
{
  "name": "account",
  "title": "Account",
  "table": { "actions": ["edit", "delete", "clone"] },
  "entity": [...]
}
```

### Built-in Tabs
- `"type": "loggingTab"` - Standard logging configuration
- `"type": "proxyTab"` - Proxy settings with optional username/password

## Input Services

```json
{
  "inputs": {
    "title": "Inputs",
    "description": "Manage your data inputs",
    "services": [
      {
        "name": "my_input",
        "title": "My Input",
        "entity": [
          { "type": "text", "field": "name", "label": "Name", "required": true },
          { "type": "text", "field": "interval", "label": "Interval", "defaultValue": "300" },
          { "type": "index", "field": "index", "label": "Index", "required": true }
        ]
      }
    ]
  }
}
```

## Alert Actions

```json
{
  "alerts": [
    {
      "name": "my_alert",
      "label": "My Alert Action",
      "description": "Description here",
      "entity": [...]
    }
  ]
}
```

## Common Patterns

### Account Configuration (OAuth/API Key)
```json
{
  "name": "account",
  "title": "Account",
  "entity": [
    { "type": "text", "field": "name", "label": "Account Name", "required": true },
    { "type": "text", "field": "api_key", "label": "API Key", "required": true, "encrypted": true }
  ]
}
```

### Data Input with Account Reference
```json
{
  "type": "singleSelect",
  "field": "account",
  "label": "Account",
  "options": {
    "referenceName": "account"
  },
  "required": true
}
```

## Python Input Script Structure

Located in `package/bin/<input_name>.py`:

```python
import import_declare_test
from splunktaucclib.alert_actions_base import ModularAction
from splunktaucclib.data_collection import DataCollection

class MyInput(DataCollection):
    def __init__(self):
        super().__init__()

    def validate_input(self, definition):
        pass

    def stream_events(self, inputs, ew):
        # Collect data and write events
        for input_name, input_item in inputs.inputs.items():
            # Your data collection logic here
            event = Event()
            event.data = json.dumps(data)
            ew.write_event(event)
```

## Best Practices

1. **Always validate inputs** - Use appropriate validators for all fields
2. **Encrypt sensitive data** - Use `"encrypted": true` for API keys, passwords
3. **Use meaningful field names** - Field names become conf file stanza keys
4. **Provide help text** - Include `help` property for user guidance
5. **Set sensible defaults** - Use `defaultValue` for optional fields
6. **Use built-in tabs** - `loggingTab` and `proxyTab` for standard config

## References

- [UCC Documentation](https://splunk.github.io/addonfactory-ucc-generator/)
- [UCC Entity Components](https://splunk.github.io/addonfactory-ucc-generator/entity/components/)
- [UCC Validators](https://splunk.github.io/addonfactory-ucc-generator/entity/validators/)
- [Example TA](https://github.com/splunk/splunk-example-ta)
