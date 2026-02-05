/**
 * Bundled Splunk Spec Files
 * Contains raw content of common .conf.spec files for validation
 */

export const SPLUNK_SPECS: Record<string, string> = {
  'app.conf': `
[launcher]
* Configuration for the Splunk App Launcher.
version = <string>
* The version of this app.
description = <string>
* A short description of the app.
author = <string>
* The name of the app author.

[package]
* Configuration for the app package.
id = <string>
* The app ID.
check_for_updates = <boolean>
* Whether to check for updates on Splunkbase.

[install]
* Installation settings.
state = enabled|disabled
* The state of the app.
is_configured = <boolean>
* Whether the app has been configured.
build = <integer>
* The build number.

[ui]
* UI settings.
is_visible = <boolean>
* Whether the app is visible in the launcher.
label = <string>
* The display label for the app.
`,

  'inputs.conf': `
[default]
* Global settings.
host = <string>
index = <string>
sourcetype = <string>
disabled = <boolean>

[monitor://<path>]
* Monitor a file or directory.
whitelist = <regex>
blacklist = <regex>
recursive = <boolean>
followTail = <boolean>

[script://<cmd>]
* Run a script and collect output.
interval = <string>
* Interval to run the script (e.g., 60 or 0 12 * * *).
passAuth = <string>

[http]
* HTTP Event Collector global settings.
port = <integer>
enableSSL = <boolean>

[http://<name>]
* Individual HEC token settings.
token = <string>
index = <string>
indexes = <string>
`,

  'commands.conf': `
[<name>]
* Custom search command configuration.
filename = <string>
* The name of the Python script.
chunked = <boolean>
* Whether to use the v2 chunked protocol.
type = python
command.arg.<name> = <string>
requires_srinfo = <boolean>
supports_multivalues = <boolean>
`,

  'alert_actions.conf': `
[<name>]
* Alert action configuration.
is_custom = <boolean>
label = <string>
description = <string>
icon_path = <string>
payload_format = json|xml
param.<name> = <string>
`
};
