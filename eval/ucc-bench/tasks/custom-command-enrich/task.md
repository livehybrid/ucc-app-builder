# Task: custom-command-enrich

Build a Splunk UCC add-on that ships a custom streaming search command named
`http_enrich` which enriches input events with a static risk score map.

Requirements:

- App id: `TA_command_enrich_demo`
- Generate:
  - `package/default/commands.conf` with stanza `http_enrich`
  - `package/bin/http_enrich.py`
- The command should use Splunk SDK search command classes (`dispatch`,
  `StreamingCommand`, `Configuration`).
- Command behavior:
  - Accept optional argument `field` (default `status`).
  - For each event, add `risk_score` based on field value:
    - `200` => `low`
    - `4xx` => `medium`
    - `5xx` => `high`
- Include safe handling when the selected field is missing.

The agent passes when:

- `ucc-gen build` succeeds.
- AppInspect has no failures.
- Script imports and command dispatch path compile under Python 3.9.
