import { Tool } from '../toolTypes';

const SPLUNKLIB_KNOWLEDGE_BASE: Record<string, string> = {
  modular_inputs: `
# creating modular inputs with splunklib (UCC)
To create a modular input in UCC:
1. Define the input in \`globalConfig.json\` under \`pages.inputs.services\`.
2. Generate the python script using \`generate_input_script\`.
3. The script must inherit from \`smi.Script\`.
4. Implement \`get_scheme\` to verify arguments.
5. Implement \`stream_events\` to yield events to Splunk.

Example Structure:
\`\`\`python
from splunklib import modularinput as smi
class MyInput(smi.Script):
    def get_scheme(self):
        scheme = smi.Scheme("my_input")
        # Define arguments
        return scheme

    def stream_events(self, inputs, ew):
        # inputs.inputs is a dict of input names to parameter dicts
        for input_name, input_item in inputs.inputs.items():
            event = smi.Event()
            event.stanza = input_name
            event.data = "data"
            ew.write_event(event)

if __name__ == "__main__":
    exit_code = MyInput().run(sys.argv)
    sys.exit(exit_code)
\`\`\`
`,
  logging: `
# Python Logging Best Practices
Use the \`import logging\` module for logging errors to splunkd.log.
However, modular inputs generally use \`ew.log(smi.EventWriter.ERROR, "msg")\`.

For helper scripts, you can configure standard logging:
\`\`\`python
import logging
import os

def setup_logging(log_level=logging.INFO):
    logger = logging.getLogger("my_app_helper")
    logger.propagate = False
    logger.setLevel(log_level)
    handler = logging.StreamHandler() # Goes to stderr which Splunk captures
    formatter = logging.Formatter('%(asctime)s %(levelname)s %(message)s')
    handler.setFormatter(formatter)
    logger.addHandler(handler)
    return logger
\`\`\`
`,
  error_handling: `
# Error Handling in UCC
1. **Validation Errors**: In \`validate_input\`, raise \`ValueError\` or return False. Splunk UI will show the error.
2. **Runtime Errors**: Catch exceptions in \`stream_events\` and log them using \`ew.log(smi.EventWriter.ERROR)\`.
3. **HTTP Errors**: Use \`response.status_code\` checks. Retry logic is recommended for transient errors (429, 503).
`,
  validation: `
# Input Validation
UCC supports two types of validation:
1. **UI Validation**: In \`globalConfig.json\`, use regex validators or string length validators.
2. **Backend Validation**: In the Python script's \`validate_input(self, validation_definition)\` method.

Example UI Validator:
\`\`\`json
{
  "type": "regex",
  "pattern": "^[a-zA-Z0-9_]+$",
  "errorMsg": "Must be alphanumeric"
}
\`\`\`
`,
  ucc_helper_module: `
# UCC Helper Utilities
Creating a helper module in \`package/bin/my_app_helper.py\` is best practice to keep the main input script clean.
Common functions to put in helper:
- API client class
- Authentication logic
- Data transformation logic
- Custom logging wrapper
`,
  entity_types: `
# UCC Entity Types
- \`text\`: Simple text input
- \`password\`: Encrypted text input (stored in passwords.conf)
- \`checkbox\`: Boolean toggle
- \`singleSelect\`: Dropdown (requires options)
- \`multipleSelect\`: Multi-select dropdown
- \`radio\`: Radio buttons
`,
  validators: `
# Available Validators
- \`string\`: { "type": "string", "minLength": 1, "maxLength": 100 }
- \`regex\`: { "type": "regex", "pattern": "^foo", "errorMsg": "Must start with foo" }
- \`number\`: { "type": "number", "range": [0, 100] }
- \`email\`: { "type": "email" }
- \`url\`: { "type": "url" }
`,
};

export const getSplunklibHelp: Tool = {
  name: 'get_splunklib_help',
  description:
    'Get detailed help and code examples for splunklib/UCC concepts. Use this to explain patterns to the user.',
  parameters: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: 'The topic to get help on',
        enum: [
          'modular_inputs',
          'error_handling',
          'logging',
          'validation',
          'ucc_helper_module',
          'entity_types',
          'validators',
        ],
      },
    },
    required: ['topic'],
  },
  execute: async (args, _vfs) => {
    const topic = args.topic as string;
    const help = SPLUNKLIB_KNOWLEDGE_BASE[topic];

    if (!help) {
      return `No help available for topic: ${topic}. Available topics: ${Object.keys(SPLUNKLIB_KNOWLEDGE_BASE).join(', ')}`;
    }

    return help;
  },
};
