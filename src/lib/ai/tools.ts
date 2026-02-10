import { VirtualFileSystem } from '../vfs';

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, vfs: VirtualFileSystem) => Promise<string>;
}

// Security: Allowed path prefixes for file operations
const ALLOWED_PATH_PREFIXES = [
  'package/',
  '/package/',
];

// Security: Blocked path patterns (directory traversal, system paths)
// These are checked for paths that START with these patterns (absolute system paths)
const BLOCKED_ABSOLUTE_PATHS = [
  '/etc/',        // System config
  '/usr/',        // System binaries
  '/var/',        // System data  
  '/bin/',        // System binaries (root level)
  '/sbin/',       // System binaries
  '/tmp/',        // Temp files (outside VFS)
  '/home/',       // Home directories
  '/root/',       // Root home
];

// Patterns that are blocked anywhere in the path
const BLOCKED_PATTERNS = [
  '..',           // Directory traversal
  'node_modules/',// Dependencies
  '.git/',        // Git internals
  '.env',         // Environment files
];

/**
 * Validates that a path is safe for the AI to access.
 * Returns null if safe, or an error message if blocked.
 */
function validatePath(path: string): string | null {
  // Normalize path
  const normalizedPath = path.replace(/\\/g, '/');
  
  // Check for blocked absolute paths (must start with pattern)
  for (const pattern of BLOCKED_ABSOLUTE_PATHS) {
    if (normalizedPath.startsWith(pattern)) {
      return `Security Error: Access to system path "${pattern}" is not allowed.`;
    }
  }
  
  // Check for blocked patterns anywhere in path
  for (const pattern of BLOCKED_PATTERNS) {
    if (normalizedPath.includes(pattern)) {
      return `Security Error: Access to "${pattern}" paths is not allowed.`;
    }
  }
  
  return null; // Path is safe
}

/**
 * Additional validation for write operations - must be in allowed directories
 */
function validateWritePath(path: string): string | null {
  const baseError = validatePath(path);
  if (baseError) return baseError;
  
  const normalizedPath = path.replace(/\\/g, '/');
  
  // For writes, must start with an allowed prefix
  const isAllowed = ALLOWED_PATH_PREFIXES.some(prefix => 
    normalizedPath.startsWith(prefix) || normalizedPath.includes(prefix)
  );
  
  if (!isAllowed) {
    return `Security Error: Write operations are only allowed within the package/ directory.`;
  }
  
  return null;
}

export const TOOLS: Tool[] = [
  {
    name: 'list_files',
    description: 'List all files in the project to understand structure.',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async (_args, vfs) => {
      const files = vfs.listAllFiles().map(f => f.path);
      return JSON.stringify(files, null, 2);
    },
  },
  {
    name: 'read_file',
    description: 'Read the content of a specific file within the project. Use this to examine existing code.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The path of the file to read (within package/)' },
      },
      required: ['path'],
    },
    execute: async (args, vfs) => {
      // Security validation
      const path = args.path as string;
      const pathError = validatePath(path);
      if (pathError) {
        return pathError;
      }
      
      const content = vfs.readFile(path);
      if (content === null) {
        return `Error: File not found: ${path}`;
      }
      return content;
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file within the package/ directory. Use this to create new files or modify existing ones.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The path of the file (must be within package/)' },
        content: { type: 'string', description: 'The full content to write' },
      },
      required: ['path', 'content'],
    },
    execute: async (args, vfs) => {
      const path = args.path as string;
      // Security validation for write operations
      const pathError = validateWritePath(path);
      if (pathError) {
        return pathError;
      }
      
      // Additional content validation - block obvious sensitive data patterns
      const content = args.content as string;
      if (content.includes('BEGIN RSA PRIVATE KEY') || 
          content.includes('BEGIN PRIVATE KEY') ||
          content.includes('-----BEGIN CERTIFICATE-----') && content.includes('-----BEGIN PRIVATE KEY-----')) {
        return 'Security Error: Writing raw private keys is not allowed. Use encrypted storage or Splunk password storage instead.';
      }
      
      vfs.writeFile(path, content, 'user');
      return `Successfully wrote to ${path}`;
    }
  },
  {
    name: 'generate_input_script',
    description: 'Generate a Python modular input script based on requirements. Returns the complete script content.',
    parameters: {
      type: 'object',
      properties: {
        input_name: { type: 'string', description: 'Name of the input (e.g., my_api_input)' },
        input_type: { 
          type: 'string', 
          description: 'Type of input: rest_api, database, file_monitor, webhook, or custom',
          enum: ['rest_api', 'database', 'file_monitor', 'webhook', 'custom']
        },
        description: { type: 'string', description: 'Description of what the input collects' },
        parameters: { 
          type: 'array', 
          description: 'Array of parameter objects with name, required, and description',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              required: { type: 'boolean' },
              description: { type: 'string' }
            }
          }
        },
        use_checkpoint: { type: 'boolean', description: 'Whether to include checkpointing for incremental collection' }
      },
      required: ['input_name', 'input_type', 'description'],
    },
    execute: async (args, _vfs) => {
      const input_name = args.input_name as string;
      const input_type = args.input_type as string;
      const description = args.description as string;
      const parameters = (args.parameters || []) as { name: string; required?: boolean; description?: string }[];
      const use_checkpoint = (args.use_checkpoint || false) as boolean;
      
      // Generate script based on type
      const className = input_name.split('_').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join('') + 'Input';
      
      let script = `"""
${description}
Generated by UCC App Builder AI Assistant
"""
import sys
import json
import time
import requests
from splunklib.modularinput import Script, Scheme, Argument, Event

`;

      if (use_checkpoint) {
        script += `from solnlib.checkpoint import KVStoreCheckpoint

`;
      }

      script += `class ${className}(Script):
    def get_scheme(self):
        scheme = Scheme("${input_name.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase())}")
        scheme.description = "${description}"
        scheme.use_external_validation = True
        scheme.use_single_instance = False
        
`;

      // Add parameters
      for (const param of parameters) {
        script += `        scheme.add_argument(Argument(
            name="${param.name}",
            title="${param.name.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase())}",
            description="${param.description || ''}",
            required_on_create=${param.required ? 'True' : 'False'},
            data_type=Argument.data_type_string
        ))
        
`;
      }

      script += `        return scheme

    def validate_input(self, definition):
        """Validate input configuration."""
        # Add your validation logic here
        pass

    def stream_events(self, inputs, ew):
        """Collect and stream events to Splunk."""
`;

      if (use_checkpoint) {
        script += `        # Initialize checkpoint
        checkpoint = KVStoreCheckpoint(
            collection_name="${input_name}_checkpoint",
            session_key=self._input_definition.metadata.get("session_key"),
            app=self._input_definition.metadata.get("app")
        )
        
`;
      }

      // Add type-specific logic
      if (input_type === 'rest_api') {
        script += `        for input_name, input_item in inputs.inputs.items():
            endpoint = input_item.get("endpoint", "")
            api_key = input_item.get("api_key", "")
            
            headers = {"Content-Type": "application/json"}
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"
            
            try:
                response = requests.get(endpoint, headers=headers, timeout=30)
                response.raise_for_status()
                data = response.json()
                
                records = data if isinstance(data, list) else [data]
                for record in records:
                    event = Event()
                    event.stanza = input_name
                    event.data = json.dumps(record)
                    ew.write_event(event)
                    
            except Exception as e:
                ew.log("ERROR", f"Failed to collect from {input_name}: {str(e)}")
`;
      } else {
        script += `        for input_name, input_item in inputs.inputs.items():
            try:
                # TODO: Implement your data collection logic here
                # Example:
                # data = fetch_data(input_item)
                # for record in data:
                #     event = Event()
                #     event.stanza = input_name
                #     event.data = json.dumps(record)
                #     ew.write_event(event)
                pass
                
            except Exception as e:
                ew.log("ERROR", f"Failed to collect from {input_name}: {str(e)}")
`;
      }

      script += `

if __name__ == "__main__":
    ${className}().run(sys.argv)
`;

      return script;
    }
  },
  {
    name: 'add_config_entity',
    description: 'Generate a globalConfig.json entity (field) entry with proper UCC format.',
    parameters: {
      type: 'object',
      properties: {
        field_name: { type: 'string', description: 'The field name (snake_case)' },
        label: { type: 'string', description: 'Display label for the field' },
        field_type: { 
          type: 'string', 
          description: 'Field type',
          enum: ['text', 'textarea', 'singleSelect', 'multipleSelect', 'checkbox', 'radioBar', 'file', 'interval', 'index']
        },
        required: { type: 'boolean', description: 'Whether field is required' },
        encrypted: { type: 'boolean', description: 'Whether to encrypt (for passwords/keys)' },
        help_text: { type: 'string', description: 'Help text for the field' },
        default_value: { type: 'string', description: 'Default value' },
        options: { 
          type: 'array', 
          description: 'For select fields: array of {label, value} objects'
        },
        validators: {
          type: 'array',
          description: 'Array of validator objects'
        }
      },
      required: ['field_name', 'label', 'field_type'],
    },
    execute: async (args, _vfs) => {
      const field_name = args.field_name as string;
      const label = args.label as string;
      const field_type = args.field_type as string;
      // Validate empty strings
      if (!field_name || !field_name.trim()) {
        return "Error: field_name cannot be empty.";
      }
      if (!label || !label.trim()) {
        return "Error: label cannot be empty.";
      }

      const entity: Record<string, unknown> = {
        type: field_type,
        field: field_name,
        label: label,
      };
      
      if (args.required) entity.required = true;
      if (args.encrypted) entity.encrypted = true;
      if (args.help_text) entity.help = args.help_text;
      if (args.default_value !== undefined) entity.defaultValue = args.default_value;
      
      // Handle select options
      if (['singleSelect', 'multipleSelect', 'radioBar'].includes(field_type) && args.options) {
        const options = args.options as { label: string; value: string }[];
        entity.options = {
          autoCompleteFields: options.map((opt) => ({
            label: opt.label,
            value: opt.value
          }))
        };
      }
      
      // Handle validators
      const validators = args.validators as unknown[] | undefined;
      if (validators && validators.length > 0) {
        entity.validators = validators;
      }
      
      return JSON.stringify(entity, null, 2);
    }
  },
  {
    name: 'get_splunklib_help',
    description: 'Get detailed help and code examples for splunklib/UCC concepts. Use this to explain patterns to the user.',
    parameters: {
      type: 'object',
      properties: {
        topic: { 
          type: 'string', 
          description: 'The topic to explain',
          enum: [
            'modular_input_basics',
            'event_writing',
            'checkpointing', 
            'credential_storage',
            'error_handling',
            'logging',
            'validation',
            'ucc_helper_module',
            'entity_types',
            'validators'
          ]
        }
      },
      required: ['topic'],
    },
    execute: async (args, _vfs) => {
      const topics: Record<string, string> = {
        modular_input_basics: `# Modular Input Basics

A modular input is a Python script extending \`splunklib.modularinput.Script\`.

**Required Methods:**
- \`get_scheme()\` - Define input parameters and metadata
- \`stream_events(inputs, ew)\` - Collect and write events

**Optional Methods:**
- \`validate_input(definition)\` - Validate configuration before saving

**Example Structure:**
\`\`\`python
from splunklib.modularinput import Script, Scheme, Argument, Event

class MyInput(Script):
    def get_scheme(self):
        scheme = Scheme("My Input")
        scheme.add_argument(Argument(name="api_key", required_on_create=True))
        return scheme
    
    def stream_events(self, inputs, ew):
        for name, item in inputs.inputs.items():
            event = Event()
            event.data = "Hello World"
            ew.write_event(event)

if __name__ == "__main__":
    MyInput().run(sys.argv)
\`\`\``,

        event_writing: `# Event Writing

Use the EventWriter (\`ew\`) to send events to Splunk:

\`\`\`python
from splunklib.modularinput import Event

event = Event()
event.stanza = input_name      # Input stanza name
event.data = json.dumps(data)  # Event data
event.time = time.time()       # Optional: event timestamp
event.sourcetype = "my_type"   # Optional: override sourcetype
event.source = "my_source"     # Optional: override source
event.index = "my_index"       # Optional: override index

ew.write_event(event)
\`\`\`

**Logging:**
\`\`\`python
ew.log("INFO", "Message here")
ew.log("ERROR", "Something went wrong")
\`\`\``,

        checkpointing: `# Checkpointing (Incremental Collection)

Use checkpoints to track state between runs:

\`\`\`python
from solnlib.checkpoint import KVStoreCheckpoint

checkpoint = KVStoreCheckpoint(
    collection_name="my_input_checkpoint",
    session_key=self._input_definition.metadata.get("session_key"),
    app=self._input_definition.metadata.get("app")
)

# Get checkpoint
state = checkpoint.get(input_name) or {"last_id": 0}

# Update checkpoint
checkpoint.update(input_name, {"last_id": new_id})
\`\`\``,

        credential_storage: `# Credential Storage

Use Splunk's secure password storage:

\`\`\`python
from solnlib.credentials import CredentialManager

manager = CredentialManager(
    session_key=session_key,
    app="my_app",
    owner="nobody",
    realm="my_realm"
)

# Get stored password
password = manager.get_password("my_credential")

# Store password
manager.set_password("my_credential", "secret_value")
\`\`\``,

        error_handling: `# Error Handling

\`\`\`python
def stream_events(self, inputs, ew):
    for input_name, input_item in inputs.inputs.items():
        try:
            data = self.collect_data(input_item)
            for record in data:
                event = Event()
                event.data = json.dumps(record)
                ew.write_event(event)
        except requests.exceptions.Timeout:
            ew.log("WARN", f"Request timed out for {input_name}")
        except requests.exceptions.HTTPError as e:
            ew.log("ERROR", f"HTTP error: {e.response.status_code}")
        except Exception as e:
            ew.log("ERROR", f"Unexpected error: {str(e)}")
\`\`\``,

        logging: `# Logging

\`\`\`python
import logging
from solnlib.log import Logs

# Setup logging
Logs.set_context(directory="my_app", namespace="my_input")
logger = logging.getLogger("my_input")

# Log messages
logger.debug("Debug message")
logger.info("Info message")
logger.warning("Warning message")
logger.error("Error message", exc_info=True)
\`\`\``,

        validation: `# Input Validation

\`\`\`python
def validate_input(self, definition):
    """Called when user saves input configuration."""
    api_url = definition.parameters.get("api_url", "")
    
    if not api_url.startswith("https://"):
        raise ValueError("API URL must use HTTPS")
    
    interval = int(definition.parameters.get("interval", 60))
    if interval < 30:
        raise ValueError("Interval must be at least 30 seconds")
\`\`\``,

        ucc_helper_module: `# UCC Input Helper Module

With UCC, use the helper module pattern:

\`\`\`python
# package/bin/my_input_helper.py

def validate_input(helper, definition):
    api_url = definition.parameters.get("api_url", "")
    if not api_url:
        raise ValueError("API URL is required")

def stream_events(helper, inputs, ew):
    # Get arguments
    api_url = helper.get_arg("api_url")
    
    # Logging
    helper.log_info("Starting collection")
    
    # HTTP request
    response = helper.send_http_request(url=api_url, method="GET")
    
    # Checkpointing
    state = helper.get_check_point("last_run") or {}
    helper.save_check_point("last_run", {"ts": time.time()})
    
    # Create event
    event = helper.new_event(data=json.dumps(data), sourcetype="my_type")
    ew.write_event(event)
\`\`\``,

        entity_types: `# UCC Entity Types

| Type | Description |
|------|-------------|
| text | Single-line text input |
| textarea | Multi-line text |
| singleSelect | Dropdown (one) |
| multipleSelect | Dropdown (many) |
| checkbox | Boolean toggle |
| radioBar | Radio buttons |
| file | File upload |
| interval | Time interval |
| index | Index selector |

**Example:**
\`\`\`json
{
  "type": "text",
  "field": "api_key",
  "label": "API Key",
  "required": true,
  "encrypted": true,
  "help": "Your API key"
}
\`\`\``,

        validators: `# UCC Validators

| Type | Properties |
|------|------------|
| string | minLength, maxLength |
| regex | pattern |
| number | range: [min, max], isInteger |
| url | (none) |
| email | (none) |

**Example:**
\`\`\`json
{
  "type": "text",
  "field": "port",
  "label": "Port",
  "validators": [
    { "type": "number", "range": [1, 65535], "isInteger": true }
  ]
}
\`\`\``,
      };
      
      return topics[args.topic as string] || 'Topic not found. Available: ' + Object.keys(topics).join(', ');
    }
  }
];

