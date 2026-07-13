/**
 * Python modular input patterns, common pitfalls, and UCC helper module conventions.
 * Update this file when the splunktaucclib/BaseModInput API changes or new pitfalls emerge.
 */

export const PYTHON_KNOWLEDGE_SECTION = `## Python pitfalls (server-side guards)
**Before writing any .py file, call \`validate_python_syntax\` with the content.** This catches IndentationError, SyntaxError, and missing colons before they reach the user. Only write after getting "OK".

Writes to \`*.py\` files are also guarded server-side against three recurring crashes:

1. **\`collect_events\` not \`stream_events\`** — For \`BaseModInput\` subclasses (the UCC/AOB pattern), override \`collect_events(self, ew)\`, NOT \`stream_events\`. \`BaseModInput.stream_events(self, inputs, ew)\` is called by Splunk and does stanza-state preprocessing before calling \`collect_events(ew)\`. Overriding \`stream_events\` directly bypasses that preprocessing and crashes with wrong argument counts. Your class method must be:
   \`\`\`python
   def collect_events(self, ew):
       return my_input_helper.stream_events(self, ew)
   \`\`\`
   The *helper file* entry point stays \`stream_events(helper, ew)\` — that is the UCC helper convention and must not be renamed.

2. **\`helper.send_http_request\` / \`helper.get_proxy\`** — only valid when the input class extends \`splunktaucclib.modinput_wrapper.base_modinput.BaseModInput\`. Without that base, \`self.setup_util\` is None at runtime and you get \`'NoneType' object has no attribute 'get_proxy_settings'\`. Always import: \`from splunktaucclib.modinput_wrapper.base_modinput import BaseModInput\`.

3. **\`super().__init__()\` in BaseModInput subclasses** — if you define a custom \`__init__\`, the FIRST line must be \`super().__init__(*args, **kwargs)\`. Skipping it leaves UCC internals uninitialized and causes the same NoneType crash above.


## Python Modular Input Knowledge (splunklib)

### Script Structure
\`\`\`python
from splunktaucclib.modinput_wrapper import base_modinput as base_mi
from splunklib import modularinput as smi

class ModInputMyInput(base_mi.BaseModInput):
    def get_scheme(self):       # Define parameters
        scheme = smi.Scheme("My Input")
        scheme.add_argument(smi.Argument(name="api_key", required_on_create=True))
        return scheme

    def validate_input(self, definition):
        return my_input_helper.validate_input(self, definition)

    def collect_events(self, ew):   # Collect data — NOT stream_events
        return my_input_helper.stream_events(self, ew)
\`\`\`

### Common Patterns
- **Checkpointing**: Use solnlib.checkpoint.KVStoreCheckpoint for incremental collection
- **Credentials**: Use solnlib.credentials.CredentialManager for secure password storage
- **Logging**: Use solnlib.log.Logs for proper Splunk logging
- **HTTP Requests**: Include timeout, error handling, and rate limiting

### UCC Helper Module Pattern
\`\`\`python
# package/bin/my_input_helper.py

# Hardcode the API endpoint as a constant (not a user-facing text field)
API_URL = "https://api.example.com/data"

def stream_events(helper, ew):
    api_key = helper.get_arg("api_key")    # encrypted field from entity
    helper.log_info("Starting collection")
    response = helper.send_http_request(url=API_URL, method="GET",
                                        headers={"x-api-key": api_key})
    event = helper.new_event(data=json.dumps(response.json()), sourcetype="my_type")
    ew.write_event(event)
\`\`\`
**IMPORTANT:** The helper module entry point MUST be named \`stream_events\`, not \`collect_events\` or anything else. The class calls it from \`collect_events\`; the helper function name is fixed by the UCC convention.

### Sensitive data in Python
- Passwords, API keys, and tokens must come from encrypted entity fields (\`encrypted: true\`) retrieved via \`helper.get_arg("field_name")\` — never hardcoded.
- Static API endpoint URLs that do not vary per user instance should be hardcoded constants, not entity fields.

### Python Libraries
- Third-party libraries should be listed in \`package/lib/requirements.txt\`.
- Do NOT use \`pip install\`.
- Instruct the user to add libraries to this file, then the build process will handle them (in a real UCC environment).
- For this builder, just ensure they are listed for documentation.

### Custom Commands
- Custom search commands should go in \`package/bin/\`.
- They must have a corresponding \`commands.conf\` entry.
- Use the SDK's \`dispatch\` or \`SearchCommand\` classes.
- If the user asks for a search command, check if one exists in \`globalConfig.json\` or the file tree first.

### Building UCC APP
The user has no access to the ucc-gen command so cannot run \`ucc-gen build\`. Instead, the user can click the green "Build App" button to build the app. This will create a build which they can then download.`;
