/**
 * Splunk App Generator
 * Generates the file structure for a UCC-based Splunk add-on
 */

import { VirtualFileSystem } from './vfs';
import type { AppMetadata, BrandingConfig } from '../types/app';
import type {
  ComponentsConfig,
  CustomCommandConfig,
  RestEndpointConfig,
} from '../types/components';
import { createGlobalConfig } from '../types/globalConfig';
import { dataUrlToBase64 } from './imageUtils';

/** Reserved path segment: must be a directory, not a file. */
const BIN_DIR = 'bin';

/**
 * Return a safe script filename for package/bin/ so we never create a file
 * named "bin" (which would block creating the bin/ directory).
 */
function safeBinScriptFilename(filename: string, commandName: string, index: number): string {
  const base = (filename || '').trim();
  if (base && base !== BIN_DIR) {
    return base.includes('.') ? base : `${base}.py`;
  }
  const safeName =
    (commandName || `command_${index}`).replace(/[^a-zA-Z0-9_-]/g, '_') || `command_${index}`;
  return `${safeName}.py`;
}

export interface GeneratorOptions {
  metadata: AppMetadata;
  branding: BrandingConfig;
  components: ComponentsConfig;
}

/**
 * Generate a complete Splunk app structure in the VFS
 */
export function generateSplunkApp(vfs: VirtualFileSystem, options: GeneratorOptions): void {
  const { metadata, branding, components } = options;
  const appId = metadata.appId || metadata.name.toLowerCase().replace(/[^a-z0-9]/g, '_');

  // Backup existing user/modified files to preserve them
  const existingFiles = vfs.listAllFiles();
  const filesToPreserve = existingFiles.filter((f) => f.source !== 'generated');

  // Clear existing files
  vfs.clear();

  // 1. Generate globalConfig.json
  const globalConfig = createGlobalConfig(
    appId,
    metadata.displayName || metadata.name,
    metadata.version,
    components
  );
  vfs.writeFile(`${appId}/globalConfig.json`, JSON.stringify(globalConfig, null, 2), 'generated');

  // 2. Generate app.manifest
  const manifest = generateAppManifest(metadata);
  vfs.writeFile(`${appId}/package/app.manifest`, JSON.stringify(manifest, null, 2), 'generated');

  // 3. Generate app.conf
  const appConf = generateAppConf(metadata, components);
  vfs.writeFile(`${appId}/package/default/app.conf`, appConf, 'generated');

  // 3a. Generate oauth.conf if needed
  const hasOauth = components.accounts.some((a) => a.authType === 'oauth');
  if (hasOauth) {
    // Find the first oauth account for now (UCC usually handles one main oauth)
    const oauthAccount = components.accounts.find((a) => a.authType === 'oauth');
    if (oauthAccount && oauthAccount.oauth) {
      const oauthConf = `[${appId}_oauth]
client_id = ${oauthAccount.oauth.clientId || ''}
client_secret = ${oauthAccount.oauth.clientSecret || ''}
auth_url = ${oauthAccount.oauth.authUrl || ''}
token_url = ${oauthAccount.oauth.tokenUrl || ''}
redirect_uri = ${oauthAccount.oauth.redirectUri || ''}
scopes = ${oauthAccount.oauth.scope || ''}
`;
      vfs.writeFile(`${appId}/package/default/oauth.conf`, oauthConf, 'generated');
    }
  }

  // 4. Generate navigation XML
  const navXml = generateNavXml(branding.navBarColor);
  vfs.writeFile(`${appId}/package/default/data/ui/nav/default.xml`, navXml, 'generated');

  // 5. Generate commands.conf (Custom Commands)
  if (components.commands.length > 0) {
    const commandsConf = generateCommandsConf(components.commands);
    vfs.writeFile(`${appId}/package/default/commands.conf`, commandsConf, 'generated');

    // Generate Python scripts for commands (avoid filename that conflicts with bin/ directory)
    components.commands.forEach((cmd, index) => {
      const scriptContent = generateCommandScript(cmd);
      const scriptFilename = safeBinScriptFilename(cmd.filename, cmd.name, index);
      vfs.writeFile(`${appId}/package/bin/${scriptFilename}`, scriptContent, 'generated');
    });
  }

  // 6. Generate alert_actions.conf (Alert Actions) with two-file pattern
  if (components.alertActions.length > 0) {
    const alertActionsConf = generateAlertActionsConf(components.alertActions);
    vfs.writeFile(`${appId}/package/default/alert_actions.conf`, alertActionsConf, 'generated');

    const alertLibDir = appId.toLowerCase().replace(/[^a-z0-9]/g, '_');

    // Generate Python scripts for alert actions (main + helper)
    components.alertActions.forEach((alert) => {
      // Main script (auto-generated, references helper)
      const mainScript = generateAlertMainScript(appId, alert.name);
      vfs.writeFile(`${appId}/package/bin/${alert.name}.py`, mainScript, 'generated');

      // Helper file (user-customizable)
      const helperScript = generateAlertHelperScript(alert.name, alert.label);
      vfs.writeFile(
        `${appId}/package/bin/${alertLibDir}/modalert_${alert.name}_helper.py`,
        helperScript,
        'generated'
      );
    });
  }

  // 7. Generate restmap.conf & web.conf (REST Endpoints)
  if (components.restEndpoints.length > 0) {
    const restmapConf = generateRestmapConf(components.restEndpoints);
    const webConf = generateWebConf(components.restEndpoints);
    vfs.writeFile(`${appId}/package/default/restmap.conf`, restmapConf, 'generated');
    vfs.writeFile(`${appId}/package/default/web.conf`, webConf, 'generated');

    // Generate Python handlers
    components.restEndpoints.forEach((endpoint) => {
      const handlerContent = generateRestHandlerScript(endpoint);
      vfs.writeFile(
        `${appId}/package/bin/${endpoint.name}_handler.py`,
        handlerContent,
        'generated'
      );
    });
  }

  // 8. Generate modular input scripts and helper files
  components.inputs.forEach((input) => {
    // Main input script (auto-generated, references helper)
    const scriptContent = generateInputScript(input.name, input.title);
    vfs.writeFile(`${appId}/package/bin/${input.name}.py`, scriptContent, 'generated');

    // Helper file (user-customizable)
    const helperContent = generateInputHelperScript(input.name);
    // Flattened path: package/bin/input_helper.py
    vfs.writeFile(`${appId}/package/bin/${input.name}_helper.py`, helperContent, 'generated');
  });

  // Generate import_declare_test.py for library path setup
  if (
    components.inputs.length > 0 ||
    components.alertActions.length > 0 ||
    components.restEndpoints.length > 0
  ) {
    const importDeclare = generateImportDeclareTest(appId);
    vfs.writeFile(`${appId}/package/bin/import_declare_test.py`, importDeclare, 'generated');
  }

  // 9. Store Icons
  if (branding.processedIcons) {
    const { appIcon, appIcon2x, appIconAlt, appIconAlt2x } = branding.processedIcons;

    vfs.writeFile(`${appId}/package/static/appIcon.png`, dataUrlToBase64(appIcon), 'generated');
    vfs.writeFile(
      `${appId}/package/static/appIcon_2x.png`,
      dataUrlToBase64(appIcon2x),
      'generated'
    );
    vfs.writeFile(
      `${appId}/package/static/appIconAlt.png`,
      dataUrlToBase64(appIconAlt),
      'generated'
    );
    vfs.writeFile(
      `${appId}/package/static/appIconAlt_2x.png`,
      dataUrlToBase64(appIconAlt2x),
      'generated'
    );
  }
  // NOTE: when there are no icons we intentionally write NOTHING into package/static/.
  // AppInspect `check_static_directory_file_allow_list` FAILS on any file in static/ that
  // is not a .png image or .txt file, so the old `static/README` placeholder broke clean
  // packaging. UCC creates the directory as needed; an empty/absent static/ is fine.

  // 10. Generate metadata files.
  // NOTE: only default.meta is emitted. AppInspect `check_for_local_meta` FAILS if a
  // local.meta is shipped in a package ("put all settings in default.meta"), so we must
  // never generate one. (Historically a local.meta was written here; removed for clean
  // AppInspect packaging.)
  const defaultMeta = generateDefaultMeta();
  vfs.writeFile(`${appId}/package/metadata/default.meta`, defaultMeta, 'generated');

  // 11. Generate README
  vfs.writeFile(
    `${appId}/package/README.txt`,
    `${metadata.displayName || metadata.name}\n${'='.repeat((metadata.displayName || metadata.name).length)}\n\n${metadata.description || 'A Splunk add-on built with UCC framework.'}\n`,
    'generated'
  );

  vfs.writeFile(
    `${appId}/package/lib/README`,
    'Third-party Python libraries go here.',
    'generated'
  );

  // 12. Generate requirements.txt template.
  // ucc-gen REQUIRES splunktaucclib (>=6.6.0) in package/lib/requirements.txt
  // whenever the add-on has a UI (configuration/inputs pages) — the build hard-
  // fails otherwise ("This add-on has an UI, so the splunktaucclib is required").
  // Inputs, accounts and REST endpoints all imply a UI here, so seed it.
  const needsUccLib =
    components.inputs.length > 0 ||
    components.accounts.length > 0 ||
    components.restEndpoints.length > 0 ||
    components.alertActions.length > 0;
  // IMPORTANT: pin solnlib to <8. solnlib 8.0.0 added grpcio + opentelemetry deps that
  // bundle AArch64-incompatible native binaries (protobuf `_upb/_message.abi3.so`,
  // grpc `_cython/cygrpc.*.so`), which makes AppInspect `check_aarch64_compatibility`
  // FAIL. solnlib 7.x has pure-Python deps only and keeps the package AppInspect-clean.
  // splunktaucclib pins `solnlib>=5` unbounded, so without our explicit upper bound it
  // resolves to solnlib 8.x. (See README "Why the dependency pins" for the full chain.)
  vfs.writeFile(
    `${appId}/package/lib/requirements.txt`,
    `# Python dependencies installed into package/lib/ during ucc-gen build.
${needsUccLib ? 'splunktaucclib>=6.6.0,<9\nsolnlib>=5.0.0,<8\n' : ''}# Add your own dependencies below, one per line. Examples:
# requests>=2.25.1
# cryptography
`,
    'generated'
  );

  // Restore preserved files
  // This ensures user edits and AI-generated files (which are 'user' or 'modified') persist
  filesToPreserve.forEach((file) => {
    vfs.writeFile(file.path, file.content, file.source as 'user' | 'generated');
  });
}

function generateAppConf(metadata: AppMetadata, components?: ComponentsConfig): string {
  const triggers = [];
  if (components?.accounts.some((a) => a.authType === 'oauth')) {
    triggers.push('install_source_checksum', 'install_source_checksum.sha256');
  }

  return `[install]
is_configured = 0
state = enabled
build = 1
${triggers.length > 0 ? `# Triggers for OAuth\n${triggers.map((t) => `${t} = 1`).join('\n')}` : ''}

[package]
id = ${metadata.appId || metadata.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}
check_for_updates = 1

[launcher]
author = ${metadata.author || 'Unknown'}
description = ${metadata.description || ''}
version = ${metadata.version || '1.0.0'}

[ui]
is_visible = 1
label = ${metadata.displayName || metadata.name}
`;
}

export function generateAppManifest(metadata: AppMetadata): object {
  return {
    schemaVersion: '2.0.0',
    info: {
      title: metadata.displayName || metadata.name,
      id: {
        group: null,
        name: metadata.appId || metadata.name.toLowerCase().replace(/[^a-z0-9]/g, '_'),
        version: metadata.version || '1.0.0',
      },
      author: [
        {
          name: metadata.author || 'Unknown',
          email: metadata.email || '',
        },
      ],
      description: metadata.description || '',
      license: {
        name: metadata.licenseName || '',
        uri: metadata.licenseUri || '',
      },
    },
    supportedDeployments: ['_standalone', '_distributed', '_search_head_clustering'],
    targetWorkloads: ['_search_heads'],
  };
}

/**
 * The metadata fields a UCC globalConfig.json carries under `meta`. Used to derive
 * a valid package/app.manifest when one was never authored (the deterministic
 * manifest guard in the agent loop). `ucc-gen` does NOT generate app.manifest, so
 * a build fails outright without it — we synthesise it from globalConfig instead
 * of relying on the flaky LLM "create the manifest" path.
 */
export interface GlobalConfigMetaLike {
  name?: string;
  version?: string;
  displayName?: string;
  description?: string;
  author?: string;
  email?: string;
}

/**
 * Build a valid app.manifest object from a parsed globalConfig.json. Reads the
 * `meta` block (name/version/displayName/description) and falls back to sensible
 * defaults for anything missing, so the result is always a buildable manifest.
 *
 * `fallbackAppId` is used when `meta.name` is absent (e.g. the inferred app id).
 */
export function appManifestFromGlobalConfig(
  globalConfig: { meta?: GlobalConfigMetaLike } | null | undefined,
  fallbackAppId?: string
): object {
  const meta: GlobalConfigMetaLike = globalConfig?.meta ?? {};
  const appId =
    (meta.name && meta.name.trim()) || (fallbackAppId && fallbackAppId.trim()) || 'splunk_addon';
  const displayName = (meta.displayName && meta.displayName.trim()) || appId;
  const metadata: AppMetadata = {
    name: appId,
    appId,
    displayName,
    version: (meta.version && String(meta.version).trim()) || '1.0.0',
    description: meta.description ?? '',
    author: meta.author ?? 'Unknown',
    email: meta.email ?? '',
    licenseName: '',
    licenseUri: '',
  };
  return generateAppManifest(metadata);
}

function generateNavXml(color: string): string {
  return `<nav search_view="search" color="${color}">
  <view name="search" default="true" />
  <view name="dashboards" />
  <view name="reports" />
  <view name="alerts" />
</nav>
`;
}

function generateCommandsConf(commands: CustomCommandConfig[]): string {
  return commands
    .map((cmd, index) => {
      const scriptFilename = safeBinScriptFilename(cmd.filename, cmd.name, index);
      return `[${cmd.name}]
filename = ${scriptFilename}
chunked = ${cmd.chunked ? 'true' : 'false'}
type = ${cmd.type || 'python'}
passauth = ${cmd.passauth ? 'true' : 'false'}
enableheader = ${cmd.enableheader ? 'true' : 'false'}
supports_multivalues = ${cmd.supports_multivalues ? 'true' : 'false'}
`;
    })
    .join('\n');
}

function generateCommandScript(cmd: CustomCommandConfig): string {
  return `#!/usr/bin/env python
# coding=utf-8

import sys
import os

from splunklib.searchcommands import \\
    dispatch, ${cmd.type === 'streaming' ? 'StreamingCommand' : cmd.type === 'generating' ? 'GeneratingCommand' : cmd.type === 'reporting' ? 'ReportingCommand' : 'EventingCommand'}, Configuration, Option, validators

@Configuration()
class ${cmd.name.charAt(0).toUpperCase() + cmd.name.slice(1)}Command(${cmd.type === 'streaming' ? 'StreamingCommand' : cmd.type === 'generating' ? 'GeneratingCommand' : cmd.type === 'reporting' ? 'ReportingCommand' : 'EventingCommand'}):
    """
    ${cmd.name} custom command
    """

    def map(self, events):
        # TODO: Implement your command logic here
        for event in events:
            yield event

    def reduce(self, events):
        for event in events:
            yield event

dispatch(${cmd.name.charAt(0).toUpperCase() + cmd.name.slice(1)}Command, sys.argv, sys.stdin, sys.stdout, __name__)
`;
}

function generateAlertActionsConf(
  alerts: { name: string; label: string; description?: string; iconPath?: string }[]
): string {
  return alerts
    .map(
      (alert) => `[${alert.name}]
is_custom = 1
label = ${alert.label}
description = ${alert.description || ''}
icon_path = ${alert.iconPath || 'appIcon.png'}
payload_format = json
`
    )
    .join('\n');
}

function generateRestmapConf(endpoints: RestEndpointConfig[]): string {
  const stanzas = endpoints.map(
    (ep) => `[script:${ep.name}]
match = /${ep.name}
handler = ${ep.name}_handler.py
scripttype = python
capability = ${ep.requiresAuth ? 'admin_all_objects' : ''}
`
  );

  return `[admin:my_app]
match = /
members = ${endpoints.map((e) => e.name).join(', ')}

${stanzas.join('\n')}
`;
}

function generateWebConf(endpoints: RestEndpointConfig[]): string {
  return endpoints
    .map(
      (ep) => `[expose:${ep.name}]
pattern = ${ep.name}
methods = ${ep.methods.join(', ')}
`
    )
    .join('\n');
}

function generateRestHandlerScript(endpoint: RestEndpointConfig): string {
  return `
import sys
from splunk.persistconn.application import PersistentServerConnectionApplication

class ${endpoint.handlerClass}(PersistentServerConnectionApplication):
    def __init__(self, _command_line, _command_arg):
        super(PersistentServerConnectionApplication, self).__init__()

    def handle(self, in_string):
        """
        Main handler method
        """
        # TODO: Implement REST logic here
        return {'payload': '{"status": "ok"}', 'status': 200}
`;
}

function generateInputScript(inputName: string, inputTitle: string): string {
  const className =
    inputName.charAt(0).toUpperCase() +
    inputName.slice(1).replace(/_([a-z])/g, (_, c) => c.toUpperCase());

  return `import import_declare_test

import sys
import json

from splunklib import modularinput as smi

import os
import traceback
import requests
from solnlib import conf_manager
from solnlib import log
from solnlib.modular_input import checkpointer
from splunktaucclib.modinput_wrapper import base_modinput as base_mi

import ${inputName}_helper

bin_dir = os.path.basename(__file__)
app_name = os.path.basename(os.path.dirname(os.getcwd()))

class ModInput${className}(base_mi.BaseModInput):

    def __init__(self):
        use_single_instance = False
        super(ModInput${className}, self).__init__(app_name, "${inputName}", use_single_instance)
        self.global_checkbox_fields = None

    def get_scheme(self):
        scheme = smi.Scheme('${inputTitle}')
        scheme.description = '${inputTitle} modular input'
        scheme.use_external_validation = True
        scheme.streaming_mode_xml = True
        scheme.use_single_instance = False

        scheme.add_argument(
            smi.Argument(
                'name',
                title='Name',
                description='Name',
                required_on_create=True
            )
        )
        return scheme

    def validate_input(self, definition):
        return ${inputName}_helper.validate_input(self, definition)

    def get_app_name(self):
        return app_name

    def stream_events(self, ew):
        return ${inputName}_helper.collect_events(self, ew)

    def get_account_fields(self):
        account_fields = []
        return account_fields

    def get_checkbox_fields(self):
        checkbox_fields = []
        return checkbox_fields

    def get_global_checkbox_fields(self):
        if self.global_checkbox_fields is None:
            checkbox_name_file = os.path.join(bin_dir, 'global_checkbox_param.json')
            try:
                if os.path.isfile(checkbox_name_file):
                    with open(checkbox_name_file, 'r') as fp:
                        self.global_checkbox_fields = json.load(fp)
                else:
                    self.global_checkbox_fields = []
            except Exception as e:
                self.log_error('Get exception when loading global checkbox parameter names. ' + str(e))
                self.global_checkbox_fields = []
        return self.global_checkbox_fields


if __name__ == '__main__':
    exit_code = ModInput${className}().run(sys.argv)
    sys.exit(exit_code)
`;
}

/**
 * Generate the helper file for a modular input (user-customizable)
 */
function generateInputHelperScript(inputName: string): string {
  return `# encoding = utf-8
"""
This module is the helper for the ${inputName} modular input.
Implement your custom data collection logic in the collect_events function.
"""


def validate_input(helper, definition):
    """
    Implement your own validation logic to validate the input stanza configurations.
    Return None if validation passes, or raise an exception if validation fails.
    """
    pass


def stream_events(helper, ew):
    """
    Implement your data collection logic here.

    helper is a ModularInputHelper object that provides useful methods:
        - helper.get_arg('arg_name') - Get input argument value
        - helper.get_output_index() - Get the output index
        - helper.get_input_stanza_names() - Get input stanza names
        - helper.send_http_request(url, method, ...) - Make HTTP requests
        - helper.log_debug/info/warning/error/critical() - Logging methods

    ew is an EventWriter object used to write events:
        - event = helper.new_event(source=..., index=..., sourcetype=..., data=...)
        - ew.write_event(event)
    """
    # TODO: Implement your data collection logic here
    helper.log_info("${inputName} collection started")

    # Example: Make an API call and write events
    # response = helper.send_http_request(url, "GET", headers=None)
    # if response.status_code == 200:
    #     data = response.json()
    #     event = helper.new_event(
    #         source="${inputName}",
    #         index=helper.get_output_index(),
    #         sourcetype="${inputName}",
    #         data=json.dumps(data)
    #     )
    #     ew.write_event(event)

    helper.log_info("${inputName} collection completed")
`;
}

function generateDefaultMeta(): string {
  return `# Application-level permissions

[]
access = read : [ * ], write : [ admin, sc_admin ]

[app/install]
access = read : [ * ], write : [ admin, sc_admin ]

[app/launcher]
access = read : [ * ], write : [ admin, sc_admin ]

[app/ui]
access = read : [ * ], write : [ admin, sc_admin ]

[commands]
export = system

[inputs]
access = read : [ * ], write : [ admin, sc_admin ]

[alert_actions]
export = system

[restmap]
export = system

[web]
export = system

[views]
access = read : [ * ], write : [ admin, sc_admin ]

[nav]
access = read : [ * ], write : [ admin, sc_admin ]

[passwords]
access = read : [ admin, sc_admin ], write : [ admin, sc_admin ]
export = system
`;
}

/**
 * Generate import_declare_test.py for library path setup (UCC pattern)
 */
function generateImportDeclareTest(appId: string): string {
  const taName = appId.toLowerCase().replace(/[^a-z0-9]/g, '_');

  return `import os
import sys
import re
from os.path import dirname

ta_name = '${taName}'
pattern = re.compile(r'[\\\\\\\\/]etc[\\\\\\\\/]apps[\\\\\\\\/][^\\\\\\\\/]+[\\\\\\\\/]bin[\\\\\\\\/]?$')
new_paths = [path for path in sys.path if not pattern.search(path) or ta_name in path]
new_paths.insert(0, os.path.join(dirname(dirname(__file__)), "lib"))
new_paths.insert(0, os.path.sep.join([os.path.dirname(__file__), ta_name]))
sys.path = new_paths
`;
}

/**
 * Generate the main alert action script (auto-generated, references helper)
 */
function generateAlertMainScript(appId: string, alertName: string): string {
  const libDir = appId.toLowerCase().replace(/[^a-z0-9]/g, '_');
  const helperModule = `modalert_${alertName}_helper`;

  return `# encoding = utf-8
import import_declare_test

import os
import sys
import json
import gzip
import csv

from ${libDir} import ${helperModule}

def process_event(helper, *args, **kwargs):
    """
    Main entry point for alert action.
    """
    return ${helperModule}.process_event(helper, *args, **kwargs)


if __name__ == "__main__":
    # This is the entry point when Splunk executes the alert action
    import modalert_${alertName}_helper as helper_module
    
    # Splunk passes the payload via stdin
    payload = json.loads(sys.stdin.read())
    
    # Create a simple helper object
    class AlertHelper:
        def __init__(self, payload):
            self.payload = payload
            
        def get_param(self, name):
            return self.payload.get('configuration', {}).get(name)
            
        def log_info(self, msg):
            sys.stderr.write(f"INFO: {msg}\\n")
            
        def log_error(self, msg):
            sys.stderr.write(f"ERROR: {msg}\\n")
    
    helper = AlertHelper(payload)
    result = helper_module.process_event(helper)
    sys.exit(0 if result == 0 else 1)
`;
}

/**
 * Generate the alert action helper file (user-customizable)
 */
function generateAlertHelperScript(alertName: string, alertLabel: string): string {
  return `# encoding = utf-8
"""
This module is the helper for the ${alertLabel} alert action.
Implement your custom alert action logic in the process_event function.
"""


def process_event(helper, *args, **kwargs):
    """
    Process the alert action.
    
    helper provides useful methods:
        - helper.get_param('param_name') - Get alert action parameter
        - helper.log_info/error() - Logging methods
        
    The payload contains:
        - results: The search results that triggered the alert
        - configuration: The alert action parameters
        - session_key: Splunk session key for API calls
    
    Returns:
        0 for success, non-zero for failure
    """
    helper.log_info("Alert action ${alertName} started")
    
    # TODO: Implement your alert action logic here
    # Example: Get a parameter value
    # my_param = helper.get_param("my_parameter")
    
    # Example: Process search results
    # for result in helper.payload.get('results', []):
    #     helper.log_info(f"Processing result: {result}")
    
    helper.log_info("Alert action ${alertName} completed")
    return 0
`;
}
