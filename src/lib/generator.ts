/**
 * Splunk App Generator
 * Generates the file structure for a UCC-based Splunk add-on
 */

import { VirtualFileSystem } from './vfs';
import type { AppMetadata, BrandingConfig } from '../types/app';
import type { ComponentsConfig, CustomCommandConfig, RestEndpointConfig } from '../types/components';
import { createGlobalConfig } from '../types/globalConfig';
import { dataUrlToBase64 } from './imageUtils';

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

  // Clear existing files
  vfs.clear();

  // 1. Generate globalConfig.json
  const globalConfig = createGlobalConfig(appId, metadata.displayName || metadata.name, metadata.version, components);
  vfs.writeFile(`${appId}/globalConfig.json`, JSON.stringify(globalConfig, null, 2));

  // 2. Generate app.manifest
  const manifest = generateAppManifest(metadata);
  vfs.writeFile(`${appId}/package/app.manifest`, JSON.stringify(manifest, null, 2));

  // 3. Generate app.conf
  const appConf = generateAppConf(metadata);
  vfs.writeFile(`${appId}/package/default/app.conf`, appConf);

  // 4. Generate navigation XML
  const navXml = generateNavXml(branding.navBarColor);
  vfs.writeFile(`${appId}/package/default/data/ui/nav/default.xml`, navXml);

  // 5. Generate commands.conf (Custom Commands)
  if (components.commands.length > 0) {
    const commandsConf = generateCommandsConf(components.commands);
    vfs.writeFile(`${appId}/package/default/commands.conf`, commandsConf);

    // Generate Python scripts for commands
    components.commands.forEach(cmd => {
      const scriptContent = generateCommandScript(cmd);
      vfs.writeFile(`${appId}/package/bin/${cmd.filename}`, scriptContent);
    });
  }

  // 6. Generate alert_actions.conf (Alert Actions)
  if (components.alertActions.length > 0) {
    const alertActionsConf = generateAlertActionsConf(components.alertActions);
    vfs.writeFile(`${appId}/package/default/alert_actions.conf`, alertActionsConf);

    // Generate Python scripts for alert actions
    components.alertActions.forEach(alert => {
      const scriptContent = generateAlertScript(alert);
      vfs.writeFile(`${appId}/package/bin/${alert.name}.py`, scriptContent);
    });
  }

  // 7. Generate restmap.conf & web.conf (REST Endpoints)
  if (components.restEndpoints.length > 0) {
    const restmapConf = generateRestmapConf(components.restEndpoints);
    const webConf = generateWebConf(components.restEndpoints);
    vfs.writeFile(`${appId}/package/default/restmap.conf`, restmapConf);
    vfs.writeFile(`${appId}/package/default/web.conf`, webConf);

    // Generate Python handlers
    components.restEndpoints.forEach(endpoint => {
      const handlerContent = generateRestHandlerScript(endpoint);
      vfs.writeFile(`${appId}/package/bin/${endpoint.name}_handler.py`, handlerContent);
    });
  }

  // 8. Generate modular input scripts
  components.inputs.forEach(input => {
    // Note: UCC usually generates the main script, but we can provide a custom base or helper
    const scriptContent = generateInputScript();
    vfs.writeFile(`${appId}/package/bin/${input.name}.py`, scriptContent);
  });

  // 9. Store Icons
  if (branding.processedIcons) {
    const { appIcon, appIcon2x, appIconAlt, appIconAlt2x } = branding.processedIcons;

    vfs.writeFile(`${appId}/package/static/appIcon.png`, dataUrlToBase64(appIcon));
    vfs.writeFile(`${appId}/package/static/appIcon_2x.png`, dataUrlToBase64(appIcon2x));
    vfs.writeFile(`${appId}/package/static/appIconAlt.png`, dataUrlToBase64(appIconAlt));
    vfs.writeFile(`${appId}/package/static/appIconAlt_2x.png`, dataUrlToBase64(appIconAlt2x));
  } else {
    vfs.writeFile(`${appId}/package/static/README`, 'Place icons here.');
  }

  // 10. Generate README
  vfs.writeFile(
    `${appId}/package/README.txt`,
    `${metadata.displayName || metadata.name}\n${'='.repeat((metadata.displayName || metadata.name).length)}\n\n${metadata.description || 'A Splunk add-on built with UCC framework.'}\n`
  );

  vfs.writeFile(`${appId}/package/lib/README`, 'Third-party Python libraries go here.');
}

function generateAppConf(metadata: AppMetadata): string {
  return `[install]
is_configured = 0
state = enabled
build = 1

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

function generateAppManifest(metadata: AppMetadata): object {
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
        },
      ],
      description: metadata.description || '',
      supportedDeployments: ['_standalone', '_distributed', '_search_head_clustering'],
      targetWorkloads: ['_search_heads'],
    },
  };
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
  return commands.map(cmd => `[${cmd.name}]
filename = ${cmd.filename}
chunked = ${cmd.chunked ? 'true' : 'false'}
type = ${cmd.type || 'python'}
passauth = ${cmd.passauth ? 'true' : 'false'}
enableheader = ${cmd.enableheader ? 'true' : 'false'}
supports_multivalues = ${cmd.supports_multivalues ? 'true' : 'false'}
`).join('\n');
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

function generateAlertActionsConf(alerts: any[]): string {
  return alerts.map(alert => `[${alert.name}]
is_custom = 1
label = ${alert.label}
description = ${alert.description || ''}
icon_path = ${alert.iconPath || 'appIcon.png'}
payload_format = json
`).join('\n');
}

function generateAlertScript(alert: any): string {
  return `
# encoding = utf-8
# Always put this line at the beginning of this file
import ta_${alert.name}_declare

import os
import sys
from splunklib.modularinput.event import Event, ET
from splunklib.modularinput.event_writer import EventWriter

def process_event(helper, *args, **kwargs):
    """
    # IMPORTANT
    # Do not remove the anchor macro:start and macro:end lines.
    # These lines are used to generate sample code. If they are
    # removed, the sample code will not be updated when configurations
    # are updated.

    [sample_code_macro:start]
    # The following example gets the alert action parameters and prints them to the log
    url = helper.get_param("url")
    helper.log_info("Alert action ${alert.name} started.")

    # TODO: Implement your alert action logic here
    [sample_code_macro:end]
    """

    helper.log_info("Alert action ${alert.name} started.")
    return 0
`;
}

function generateRestmapConf(endpoints: RestEndpointConfig[]): string {
  const stanzas = endpoints.map(ep => `[script:${ep.name}]
match = /${ep.name}
handler = ${ep.name}_handler.py
scripttype = python
capability = ${ep.requiresAuth ? 'admin_all_objects' : ''}
`);

  return `[admin:my_app]
match = /
members = ${endpoints.map(e => e.name).join(', ')}

${stanzas.join('\n')}
`;
}

function generateWebConf(endpoints: RestEndpointConfig[]): string {
  return endpoints.map(ep => `[expose:${ep.name}]
pattern = ${ep.name}
methods = ${ep.methods.join(', ')}
`).join('\n');
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

function generateInputScript(): string {
  return `
import sys
import os

# TODO: Add your modular input logic here
# This is a placeholder for custom logic
`;
}
